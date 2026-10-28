import { randomUUID } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Health, StartScreenRequest } from '@openbot/computer'
import { type ScreenManager, ScreenNotRunningError } from './screen-manager.ts'

// Duplicated from @openbot/computer's protocol: the daemon imports nothing at runtime, so it starts before installs.
const botIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const bootHeader = 'x-openbot-desktopd-boot'

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

function send(res: ServerResponse, status: number, body?: unknown) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' }).end(payload)
}

async function route(manager: ScreenManager, bootId: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://desktopd')
  if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { ok: true, bootId } satisfies Health)
  if (url.pathname === '/screens' && req.method === 'GET') return send(res, 200, manager.list())
  const match = /^\/screens\/([^/]+)(\/pids|\/browser)?$/.exec(url.pathname)
  if (!match) return send(res, 404, { error: 'Not found' })
  const botId = decodeURIComponent(match[1]!)
  if (!botIdPattern.test(botId)) return send(res, 400, { error: `Invalid bot id ${botId}` })
  if (match[2] === '/pids') return req.method === 'GET' ? send(res, 200, manager.pids(botId)) : send(res, 405, { error: 'Method not allowed' })
  if (match[2] === '/browser') {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
    try {
      await manager.openBrowser(botId)
    } catch (error) {
      if (error instanceof ScreenNotRunningError) return send(res, 409, { error: error.message })
      throw error
    }
    return send(res, 204)
  }
  switch (req.method) {
    case 'GET':
      return send(res, 200, manager.status(botId))
    case 'PUT': {
      const body = (await readJson(req)) as Partial<StartScreenRequest> | undefined
      const display = body?.display
      if (typeof display !== 'number' || !Number.isInteger(display) || display < 1 || display > 999) {
        return send(res, 400, { error: 'display must be a whole number from 1 to 999' })
      }
      return send(res, 200, await manager.start({ botId, display }))
    }
    case 'DELETE':
      await manager.stop(botId)
      return send(res, 204)
    default:
      return send(res, 405, { error: 'Method not allowed' })
  }
}

/**
 * Serves the daemon's API on a Unix socket that every local user may connect to: the server runs as another user, and
 * bots, the only others on the computer, have root anyway (ADR 0002).
 */
export async function serve(manager: ScreenManager, socketPath: string): Promise<Server> {
  // New each time the daemon starts, so the server can tell it restarted and bring its screens back.
  const bootId = randomUUID()
  const server = createServer((req, res) => {
    res.setHeader(bootHeader, bootId)
    route(manager, bootId, req, res).catch((error: Error) => {
      if (!res.headersSent) send(res, error instanceof SyntaxError ? 400 : 500, { error: error.message })
    })
  })
  await rm(socketPath, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o666)
  return server
}
