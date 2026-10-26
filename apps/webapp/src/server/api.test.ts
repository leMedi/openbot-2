import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
async function start(dataDir?: string) {
  const server = await createTestServer({ dataDir })
  servers.push(server)
  return server
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function firstEvent(server: TestServer) {
  const controller = new AbortController()
  const events = await server.client.events(undefined, { signal: controller.signal })
  const { done, value } = await events.next()
  controller.abort()
  return done ? undefined : value
}

describe('health and the live event stream', () => {
  it('reports health and greets subscribers with a stamped hello', async () => {
    const server = await start()

    const health = await server.client.health()
    const hello = await firstEvent(server)

    expect(health).toEqual({ status: 'ok', epoch: expect.any(String) })
    expect(hello).toEqual({ epoch: health.epoch, seq: expect.any(Number), event: { type: 'hello' } })
  })

  it('starts a new epoch when the server restarts on the same data', async () => {
    const before = await start()
    const epochBefore = (await firstEvent(before))?.epoch
    await before.close()

    const after = await start(before.dataDir)
    const epochAfter = (await firstEvent(after))?.epoch

    expect(epochAfter).toBeDefined()
    expect(epochAfter).not.toBe(epochBefore)
  })
})

describe('HTTP', () => {
  it('serves procedures as plain HTTP under /api', async () => {
    const server = await start()

    const response = await server.fetch('/api/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', epoch: expect.any(String) })
  })

  it('publishes an OpenAPI description', async () => {
    const server = await start()

    const response = await server.fetch('/api/openapi.json')
    const spec = await response.json()

    expect(response.status).toBe(200)
    expect(spec.openapi).toMatch(/^3\./)
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/health', '/events']))
  })

  it('streams events as server-sent events', async () => {
    const server = await start()
    const controller = new AbortController()

    const response = await server.fetch('/api/events', { signal: controller.signal })
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let received = ''
    while (!received.includes('data:')) received += (await reader.read()).value
    controller.abort()

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(received).toContain('"type":"hello"')
  })
})
