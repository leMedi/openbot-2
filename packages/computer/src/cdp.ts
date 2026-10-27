/** A Chrome DevTools Protocol error, or a browser that couldn't be reached. */
export class CdpError extends Error {}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } }

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void

/** One WebSocket to a browser's DevTools, with flat sessions for its tabs. */
export class Cdp {
  readonly #ws: WebSocket
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  readonly #listeners = new Set<{ method: string; listener: Listener }>()
  /** Ends every `waitFor` early, as undefined, when the connection closes. */
  readonly #waiters = new Set<() => void>()
  #nextId = 1
  #closed = false

  private constructor(ws: WebSocket) {
    this.#ws = ws
    ws.onmessage = (event) => this.#receive(JSON.parse(String(event.data)) as Message)
    ws.onclose = () => this.#end()
  }

  /** Connects to the browser whose DevTools listen on `port` on this machine. */
  static async connect(port: number, timeout = 5_000): Promise<Cdp> {
    let url: string
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeout) })
      if (!response.ok) throw new Error(`it answered ${response.status}`)
      url = ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
    } catch (error) {
      throw new CdpError(`The browser's DevTools on port ${port} can't be reached: ${(error as Error).message}`)
    }
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close()
        reject(new CdpError(`The browser's DevTools on port ${port} didn't answer`))
      }, timeout)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new CdpError(`The browser's DevTools on port ${port} refused the connection`))
      }
    })
    return new Cdp(ws)
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Calls `method`, on a tab's session when `sessionId` is given. */
  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string, timeout = 30_000): Promise<T> {
    if (this.#closed) return Promise.reject(new CdpError('The browser closed its DevTools connection'))
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(`The browser took too long to answer ${method}`))
      }, timeout)
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
      } catch (error) {
        this.#pending.get(id)?.reject(new CdpError(`Couldn't send ${method}: ${(error as Error).message}`))
        this.#pending.delete(id)
      }
    })
  }

  /** Calls `listener` on every `method` event; returns a function that stops it. */
  on(method: string, listener: Listener): () => void {
    const entry = { method, listener }
    this.#listeners.add(entry)
    return () => this.#listeners.delete(entry)
  }

  /**
   * Resolves with the first `method` event on `sessionId` that `matches` within `timeout` ms, or undefined after. Starts
   * listening at once, so it can be set up before the action that causes the event.
   */
  waitFor(
    method: string,
    sessionId: string,
    timeout: number,
    matches: (params: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown> | undefined> {
    if (this.#closed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const done = (params: Record<string, unknown> | undefined) => {
        clearTimeout(timer)
        off()
        this.#waiters.delete(gaveUp)
        resolve(params)
      }
      const gaveUp = () => done(undefined)
      const timer = setTimeout(gaveUp, timeout)
      const off = this.on(method, (params, session) => {
        if (session === sessionId && matches(params)) done(params)
      })
      this.#waiters.add(gaveUp)
    })
  }

  close() {
    this.#ws.close()
    this.#end()
  }

  /** Fails what is waiting for an answer and ends every wait for an event. */
  #end() {
    if (this.#closed && !this.#pending.size && !this.#waiters.size) return
    this.#closed = true
    for (const { reject } of this.#pending.values()) reject(new CdpError('The browser closed its DevTools connection'))
    this.#pending.clear()
    for (const gaveUp of [...this.#waiters]) gaveUp()
  }

  #receive(message: Message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new CdpError(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (!message.method) return
    for (const { method, listener } of this.#listeners) if (method === message.method) listener(message.params ?? {}, message.sessionId)
  }
}
