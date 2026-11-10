/**
 * How long a streamed response may go without a byte before it counts as dead: three of the server's 5 s keep-alives.
 * A connection that dies without an error (Wi-Fi to cellular, Tailscale re-keying, a socket the OS reclaimed while the
 * app was suspended) may otherwise hang for minutes.
 */
export const streamStallMs = 15_000

type Fetch = (request: Request, init?: RequestInit) => Promise<Response>

/**
 * Wraps `fetch` for a streamed response such as the live event stream: the request is aborted, and the stream ends in
 * an error, when the headers or the next bytes take longer than `stallMs`. The server's keep-alive comments count as
 * bytes, though the SSE decoder swallows them, which is why this watches the body rather than the events.
 *
 * The response's `body` is replaced on the response itself, not by building a new `Response`: React Native's
 * `Response` can't hold a stream, while `expo/fetch`'s can. Only `body` is watched, so read the response through it
 * (as oRPC's link does for an event stream): `text()` or `json()` would find the original stream locked.
 */
export function watchStalls(fetch: Fetch, stallMs = streamStallMs): Fetch {
  return async (request, init) => {
    const controller = new AbortController()
    const callerSignal = init?.signal ?? request.signal
    const stop = (reason: unknown) => controller.abort(reason)
    if (callerSignal?.aborted) stop(callerSignal.reason)
    const onCallerAbort = () => stop(callerSignal?.reason)
    callerSignal?.addEventListener('abort', onCallerAbort)

    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => stop(new Error(`No data for ${stallMs / 1000} s`)), stallMs)
    }

    arm()
    let response: Response
    try {
      response = await fetch(request, { ...init, signal: controller.signal })
    } catch (error) {
      done()
      throw error
    }
    const body = response.body
    if (!body) {
      done()
      return response
    }
    arm()
    const watched = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          arm()
          stream.enqueue(chunk)
        },
        flush: done,
      }),
    )
    // An aborted request (by the caller or the watch) ends the watch. A body that errored, or that its reader cancelled,
    // is aborted by the timer at the latest, which is harmless (a transformer's cancel isn't available everywhere).
    controller.signal.addEventListener('abort', done)
    Object.defineProperty(response, 'body', { value: watched, configurable: true })
    return response
  }
}
