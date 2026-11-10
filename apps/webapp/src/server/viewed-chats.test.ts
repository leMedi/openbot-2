import type { NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = { name: 'Rex', title: 'Builder', instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null }

const second = 1000

/** A server with Rex and Ana. */
async function twoBots() {
  const server = await createTestServer({ now: new Date('2026-11-10T12:00:00Z') })
  servers.push(server)
  const [rexBot, ana] = [await server.client.bots.create(rex), await server.client.bots.create({ ...rex, name: 'Ana' })]
  return { server, rex: rexBot, ana }
}

describe('viewed chats', () => {
  it('a chat is viewed once a client says the owner is viewing it, and only that chat', async () => {
    const { server, rex, ana } = await twoBots()
    expect(server.viewedChats.isViewed(rex.chatId)).toBe(false)

    await server.client.chats.viewing({ chatId: rex.chatId })

    expect(server.viewedChats.isViewed(rex.chatId)).toBe(true)
    expect(server.viewedChats.isViewed(ana.chatId)).toBe(false)
  })

  it('stays viewed only while the latest heartbeat is fresh: 45 s, so one late heartbeat still counts', async () => {
    const { server, rex } = await twoBots()
    await server.client.chats.viewing({ chatId: rex.chatId })

    await server.clock.advance(45 * second - 1)
    expect(server.viewedChats.isViewed(rex.chatId)).toBe(true)
    await server.clock.advance(1)
    expect(server.viewedChats.isViewed(rex.chatId)).toBe(false)
  })

  it('stays viewed while heartbeats keep coming about every 30 s', async () => {
    const { server, rex } = await twoBots()
    for (let beat = 0; beat < 4; beat++) {
      await server.client.chats.viewing({ chatId: rex.chatId })
      await server.clock.advance(40 * second)
      expect(server.viewedChats.isViewed(rex.chatId)).toBe(true)
    }
    await server.clock.advance(5 * second)
    expect(server.viewedChats.isViewed(rex.chatId)).toBe(false)
  })

  it('counts a heartbeat from any client: the phone and a tab viewing different chats', async () => {
    const { server, rex, ana } = await twoBots()
    await server.client.chats.viewing({ chatId: rex.chatId })
    await server.clock.advance(20 * second)
    await server.client.chats.viewing({ chatId: ana.chatId })

    await server.clock.advance(30 * second)
    expect([server.viewedChats.isViewed(rex.chatId), server.viewedChats.isViewed(ana.chatId)]).toEqual([false, true])
  })

  it('refuses an unknown chat', async () => {
    const { server } = await twoBots()
    await expect(server.client.chats.viewing({ chatId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(server.viewedChats.isViewed('nope')).toBe(false)
  })
})
