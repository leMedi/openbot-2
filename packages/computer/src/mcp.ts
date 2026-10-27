import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** A failed call, or an MCP server that couldn't be reached or went away. */
export class McpError extends Error {}

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: string }

/** What a tool call gave back. A tool that failed or refused may say so with `isError` rather than an error. */
export type McpToolResult = { content: McpContent[]; structuredContent?: Record<string, unknown>; isError?: boolean }

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

const protocolVersion = '2025-06-18'

/**
 * A client of one MCP server run as a child process over stdio (newline-delimited JSON-RPC): just enough of the
 * protocol to call tools.
 */
export class McpClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #closed = false
  #stderr = ''

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child
    createInterface({ input: child.stdout }).on('line', (line) => this.#receive(line))
    child.stderr.on('data', (data: Buffer) => {
      // The last lines only, to explain an exit.
      this.#stderr = (this.#stderr + data.toString('utf8')).slice(-2_000)
    })
    child.once('exit', (code, signal) => this.#end(`it exited (${signal ?? code})${this.#stderr.trim() ? `: ${this.#stderr.trim()}` : ''}`))
    child.once('error', (error) => this.#end(error.message))
    child.stdin.on('error', () => {})
  }

  /** Starts `command` and completes MCP's handshake with it. */
  static async start(command: string[], timeout = 15_000): Promise<McpClient> {
    const [file, ...args] = command
    const client = new McpClient(spawn(file!, args, { stdio: ['pipe', 'pipe', 'pipe'] }))
    try {
      await client.#request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'openbot', version: '1' } }, timeout)
      client.#send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  callTool(name: string, args: Record<string, unknown>, timeout = 60_000): Promise<McpToolResult> {
    return this.#request('tools/call', { name, arguments: args }, timeout) as Promise<McpToolResult>
  }

  close(): void {
    if (this.#closed) return
    this.#end('it was closed')
    this.#child.stdin.end()
    this.#child.kill('SIGTERM')
  }

  #request(method: string, params: unknown, timeout: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new McpError(`The MCP server is gone`))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new McpError(`${method} got no answer within ${timeout / 1000} s`))
      }, timeout)
      this.#pending.set(id, { resolve, reject, timer })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  #send(message: unknown) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #receive(line: string) {
    let message: { id?: number; result?: unknown; error?: { message: string }; method?: string }
    try {
      message = JSON.parse(line)
    } catch {
      return // Not ours: a log line.
    }
    // A request or notification from the server (logging, progress); nothing here needs answering.
    if (message.id === undefined || message.method) return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new McpError(message.error.message))
    else pending.resolve(message.result)
  }

  #end(why: string) {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new McpError(`The MCP server is gone: ${why}`))
    }
    this.#pending.clear()
  }
}
