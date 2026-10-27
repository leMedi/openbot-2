import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'

/** How long a ticket can be used for; the stream it opens lasts until closed. */
export const ticketTtlMs = 30_000

type Ticket = { botId: string; port: number; expiresAt: number }

/**
 * Short-lived, single-use tickets to a screen's stream. They live in the server's memory only: the stream proxy runs
 * in the same process as the API that issues them.
 */
export class ScreenTickets {
  readonly #tickets = new Map<string, Ticket>()
  readonly #now: () => number

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.#now = now
  }

  /** A ticket to the stream on local `port` of `botId`'s screen. */
  issue(botId: string, port: number): { ticket: string; expiresAt: number } {
    this.#sweep()
    const ticket = randomBytes(24).toString('base64url')
    const expiresAt = this.#now() + ticketTtlMs
    this.#tickets.set(ticket, { botId, port, expiresAt })
    return { ticket, expiresAt }
  }

  /** The stream's port for a ticket to `botId`'s screen that hasn't expired or been used; it can't be used again. */
  redeem(ticket: string, botId: string): number | undefined {
    const found = this.#tickets.get(ticket)
    this.#tickets.delete(ticket)
    if (!found || found.botId !== botId || found.expiresAt <= this.#now()) return undefined
    return found.port
  }

  #sweep() {
    const now = this.#now()
    for (const [ticket, { expiresAt }] of this.#tickets) if (expiresAt <= now) this.#tickets.delete(ticket)
  }
}

const processTickets = Symbol.for('openbot.screenTickets')

/**
 * The server's one ticket store. Kept on `globalThis` because the HTTP server's upgrade hook (a Vite plugin) and the
 * API (loaded through Vite's module runner) are separate module instances in one process.
 */
export function serverScreenTickets(): ScreenTickets {
  const global = globalThis as { [processTickets]?: ScreenTickets }
  global[processTickets] ??= new ScreenTickets()
  return global[processTickets]
}

const streamPath = /^\/api\/screens\/([A-Za-z0-9_-]+)\/stream$/

/** Where a ticket's stream is opened, as a WebSocket. */
export function screenStreamUrl(botId: string, ticket: string): string {
  return `/api/screens/${botId}/stream?ticket=${encodeURIComponent(ticket)}`
}

/** How much of the screen's stream may wait for a slow viewer before the screen is paused. */
const maxBufferedBytes = 4 * 1024 * 1024

const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false })

function refuse(socket: Duplex) {
  socket.end(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * An HTTP server's `upgrade` handler for screen streams: a WebSocket at `/api/screens/:botId/stream?ticket=…` is
 * bridged to the screen's local VNC port, byte for byte. Returns false for other paths, which are left alone (e.g.
 * for Vite's hot reload).
 */
export function handleScreenUpgrade(tickets: ScreenTickets, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url ?? '/', 'http://openbot')
  const match = streamPath.exec(url.pathname)
  if (!match) return false
  const port = tickets.redeem(url.searchParams.get('ticket') ?? '', match[1]!)
  if (port === undefined) {
    refuse(socket)
    return true
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    const screen = connect({ host: '127.0.0.1', port })
    // Each side waits while the other can't keep up, so a slow viewer doesn't pile frames up in the server.
    screen.on('data', (data) => {
      ws.send(data)
      if (ws.bufferedAmount > maxBufferedBytes) {
        screen.pause()
        const resume = () => (ws.bufferedAmount > maxBufferedBytes / 2 && ws.readyState === ws.OPEN ? setTimeout(resume, 20) : screen.resume())
        setTimeout(resume, 20)
      }
    })
    screen.on('drain', () => ws.resume())
    screen.on('close', () => ws.close())
    screen.on('error', () => ws.close(1011, "Can't reach the screen"))
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (!screen.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer))) ws.pause()
    })
    ws.on('close', () => screen.destroy())
    ws.on('error', () => screen.destroy())
  })
  return true
}
