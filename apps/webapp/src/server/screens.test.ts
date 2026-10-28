import type { NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const newBot = (name: string): NewBot => ({ name, title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })

async function start() {
  const server = await createTestServer()
  servers.push(server)
  return server
}

/** The first message on a stream: the screen's VNC greeting. */
function firstMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.onmessage = (event) => resolve(Buffer.from(event.data as ArrayBuffer).toString('latin1'))
  })
}

describe('screens', () => {
  it("start when a bot is created, each at the bot's own display", async () => {
    const server = await start()

    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))

    expect(server.computer.calls).toEqual([
      { bot: 'Rex', kind: 'screens.start', display: 1 },
      { bot: 'Ada', kind: 'screens.start', display: 2 },
    ])
    expect(await server.client.screens.status({ botId: rex.id })).toMatchObject({ state: 'running', width: 1280, height: 800 })
    expect((await server.client.screens.status({ botId: ada.id })).state).toBe('running')
  })

  it('stop when their bot is deleted', async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))

    await server.client.bots.delete({ botId: rex.id })

    expect(server.computer.calls.at(-1)).toEqual({ bot: 'Rex', kind: 'screens.stop' })
    expect(await server.computer.screens.list()).toEqual([])
  })

  it('keep running across a server restart, and the server stops screens of bots it no longer has', async () => {
    const before = await start()
    const rex = await before.client.bots.create(newBot('Rex'))
    const running = await before.computer.screens.status(rex)
    // A screen the computer kept for a bot deleted while it couldn't be reached.
    await before.computer.screens.start({ id: 'gone', name: 'Gone', display: 9 })

    const after = await restartTestServer(before)
    servers.splice(servers.indexOf(before), 1, after)

    expect(await after.computer.screens.status(rex)).toEqual(running)
    expect((await after.computer.screens.list()).map((screen) => screen.botId)).toEqual([rex.id])
  })

  it('come back on their displays when the screen daemon restarts, without anyone opening them', async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))

    await server.computer.restart()

    await expect.poll(async () => (await server.computer.screens.list()).map(({ botId, display }) => ({ botId, display }))).toEqual([
      { botId: rex.id, display: 1 },
      { botId: ada.id, display: 2 },
    ])
  })

  it('are only read by their routes: a stopped screen is reported, not started', async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    await server.computer.screens.stop(rex)
    const calls = server.computer.calls.length

    expect((await server.client.screens.status({ botId: rex.id })).state).toBe('stopped')
    await expect(server.client.screens.ticket({ botId: rex.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: "Rex's screen isn't running",
    })
    expect(server.computer.calls.length).toBe(calls)
  })

  it('stream live to the owner on a ticket', async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))

    const { url } = await server.client.screens.ticket({ botId: rex.id })
    const ws = await server.openStream(url)

    expect(url).toMatch(new RegExp(`^/api/screens/${rex.id}/stream\\?ticket=`))
    expect(await firstMessage(ws)).toBe('RFB 003.008\n')
    ws.close()
  })

  it('refuse a stream without a valid ticket, with a used one, or with one for another screen', async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))
    const { url } = await server.client.screens.ticket({ botId: rex.id })
    ;(await server.openStream(url)).close()
    const forAda = await server.client.screens.ticket({ botId: ada.id })

    await expect(server.openStream(`/api/screens/${rex.id}/stream`)).rejects.toThrow('refused')
    await expect(server.openStream(`/api/screens/${rex.id}/stream?ticket=made-up`)).rejects.toThrow('refused')
    await expect(server.openStream(url)).rejects.toThrow('refused')
    await expect(server.openStream(forAda.url.replace(ada.id, rex.id))).rejects.toThrow('refused')
  })

  it('give no ticket for an unknown bot', async () => {
    const server = await start()

    await expect(server.client.screens.ticket({ botId: 'nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.screens.status({ botId: 'nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
