import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamStallMs, watchStalls } from './stall.ts'

/**
 * A server answering with a stream it writes to as the test says, as the live event stream is; `signal` is the
 * request's, as fetch saw it.
 */
function fakeStreamServer() {
  const server = {
    signal: undefined as AbortSignal | undefined,
    send: (_chunk: string) => {},
    end: () => {},
    /** Answers only once called, to hold back the headers. */
    answer: () => {},
  }
  const fetch = (request: Request, init?: RequestInit) => {
    server.signal = init?.signal ?? request.signal
    return new Promise<Response>((resolve, reject) => {
      server.signal!.addEventListener('abort', () => reject(server.signal!.reason))
      server.answer = () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            server.send = (chunk) => controller.enqueue(new TextEncoder().encode(chunk))
            server.end = () => controller.close()
            server.signal!.addEventListener('abort', () => controller.error(server.signal!.reason))
          },
        })
        resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
      }
    })
  }
  return { server, fetch }
}

async function readAll(response: Response): Promise<string> {
  return await new Response(response.body).text()
}

describe('the stall watchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('passes the stream through while bytes keep arriving, keep-alives included', async () => {
    const { server, fetch } = fakeStreamServer()
    const answered = watchStalls(fetch)(new Request('http://instance/api/events'))
    server.answer()
    const response = await answered
    const text = readAll(response)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5000)
      server.send(': keep-alive\n\n')
    }
    server.send('data: {}\n\n')
    server.end()

    expect(await text).toBe(': keep-alive\n\n'.repeat(5) + 'data: {}\n\n')
    expect(server.signal!.aborted).toBe(false)
  })

  it('ends the stream in an error once nothing arrives for 15 s, aborting the request', async () => {
    const { server, fetch } = fakeStreamServer()
    const answered = watchStalls(fetch)(new Request('http://instance/api/events'))
    server.answer()
    const text = readAll(await answered)
    const failed = expect(text).rejects.toThrow()
    server.send(': keep-alive\n\n')

    await vi.advanceTimersByTimeAsync(streamStallMs - 1)
    expect(server.signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(server.signal!.aborted).toBe(true)
  })

  it("fails the request when the headers don't arrive within 15 s", async () => {
    const { server, fetch } = fakeStreamServer()
    const answered = watchStalls(fetch)(new Request('http://instance/api/events'))
    const failed = expect(answered).rejects.toThrow()

    await vi.advanceTimersByTimeAsync(streamStallMs)
    await failed
    expect(server.signal!.aborted).toBe(true)
  })

  it('still ends when the caller aborts', async () => {
    const { server, fetch } = fakeStreamServer()
    const caller = new AbortController()
    const answered = watchStalls(fetch)(new Request('http://instance/api/events', { signal: caller.signal }))
    server.answer()
    const text = readAll(await answered)
    const failed = expect(text).rejects.toThrow()
    caller.abort()
    await failed
    expect(server.signal!.aborted).toBe(true)
  })

  it("doesn't abort once the stream ended", async () => {
    const { server, fetch } = fakeStreamServer()
    const answered = watchStalls(fetch)(new Request('http://instance/api/events'))
    server.answer()
    const text = readAll(await answered)
    server.end()
    expect(await text).toBe('')

    await vi.advanceTimersByTimeAsync(streamStallMs * 2)
    expect(server.signal!.aborted).toBe(false)
  })
})
