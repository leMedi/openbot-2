import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
async function start() {
  const server = await createTestServer()
  servers.push(server)
  return server
}
async function restart(server: TestServer) {
  servers.splice(servers.indexOf(server), 1, await restartTestServer(server))
  return servers.at(-1)!
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('health', () => {
  it("reports the instance's ID and the API version, which the phone checks an address against", async () => {
    const server = await start()

    const response = await server.fetch('/api/health')

    expect(await response.json()).toEqual({
      status: 'ok',
      epoch: expect.any(String),
      version: 'dev',
      instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      apiVersion: 1,
    })
  })

  it('keeps the same instance ID across restarts, while the epoch changes', async () => {
    const before = await start()
    const first = await before.client.health()

    const after = await restart(before)
    const second = await after.client.health()

    expect(second.instanceId).toBe(first.instanceId)
    expect(second.epoch).not.toBe(first.epoch)
  })

  it('gives each instance its own ID', async () => {
    const [one, two] = await Promise.all([start(), start()])

    expect((await one.client.health()).instanceId).not.toBe((await two.client.health()).instanceId)
  })
})
