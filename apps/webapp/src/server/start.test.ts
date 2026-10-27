import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from './start.ts'

/** A built web app, as `vite build` leaves it: static files in client/, the server's fetch handler in server/. */
function fakeBuild(): string {
  const dist = mkdtempSync(join(tmpdir(), 'openbot-dist-'))
  mkdirSync(join(dist, 'client', 'assets'), { recursive: true })
  mkdirSync(join(dist, 'server'))
  writeFileSync(join(dist, 'client', 'assets', 'app-123.js'), 'console.log("hi")\n')
  writeFileSync(
    join(dist, 'server', 'server.js'),
    'export default { fetch: (request) => new Response(`app ${request.method} ${new URL(request.url).pathname}`) }\n',
  )
  return dist
}

/** An HTTP upgrade request to `path`: the status it was answered with, or `closed` when the socket was dropped. */
function upgrade(url: string, path: string): Promise<number | 'closed'> {
  return new Promise((resolve) => {
    const req = request(new URL(path, url), { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
    req.on('response', (res) => resolve(res.statusCode!))
    req.on('upgrade', (res) => resolve(res.statusCode!))
    req.on('error', () => resolve('closed'))
    req.end()
  })
}

let server: Awaited<ReturnType<typeof startServer>> | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('the production server', () => {
  it('serves the built static files, and everything else through the app', async () => {
    server = await startServer({ dist: fakeBuild(), hostname: '127.0.0.1', port: 0 })

    const asset = await fetch(new URL('/assets/app-123.js', server.url))
    const page = await fetch(new URL('/bots/1', server.url))
    const api = await fetch(new URL('/api/health', server.url), { method: 'POST' })

    expect([asset.status, asset.headers.get('content-type'), await asset.text()]).toEqual([
      200,
      'text/javascript; charset=utf-8',
      'console.log("hi")\n',
    ])
    expect(await page.text()).toBe('app GET /bots/1')
    expect(await api.text()).toBe('app POST /api/health')
  })

  it('takes screen streams on the same port, refusing them without a ticket, and closes other upgrades', async () => {
    server = await startServer({ dist: fakeBuild(), hostname: '127.0.0.1', port: 0 })

    expect(await upgrade(server.url, '/api/screens/bot1/stream?ticket=nope')).toBe(401)
    expect(await upgrade(server.url, '/somewhere-else')).toBe('closed')
  })
})
