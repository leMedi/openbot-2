import { type ChatInfo, isMuted, type LiveEvent, type NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = { name: 'Rex', title: 'Builder', instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null }

const minute = 60_000
const hour = 60 * minute
const noon = new Date('2026-11-10T12:00:00Z')

/** A server on a clock at noon, with Rex and Ana. */
async function twoBots() {
  const server = await createTestServer({ now: noon })
  servers.push(server)
  const [rexBot, ana] = [await server.client.bots.create(rex), await server.client.bots.create({ ...rex, name: 'Ana' })]
  return { server, rex: rexBot, ana }
}

/** Each chat's mute, by chat id. */
const mutes = async (server: TestServer) => Object.fromEntries((await server.client.chats.list()).map((chat: ChatInfo) => [chat.id, chat.mutedUntil]))

describe('muted chats', () => {
  it('start unmuted', async () => {
    const { server, rex, ana } = await twoBots()
    expect(await mutes(server)).toEqual({ [rex.chatId]: null, [ana.chatId]: null })
  })

  it('mute for 1 hour, 8 hours or 1 day from now, or until unmuted', async () => {
    const { server, rex, ana } = await twoBots()

    const chats = await server.client.chats.mute({ chatIds: [rex.chatId], duration: '1h' })
    expect(chats.find((chat) => chat.id === rex.chatId)?.mutedUntil).toBe(noon.getTime() + hour)
    expect(await mutes(server)).toEqual({ [rex.chatId]: noon.getTime() + hour, [ana.chatId]: null })

    await server.client.chats.mute({ chatIds: [rex.chatId], duration: '8h' })
    expect((await mutes(server))[rex.chatId]).toBe(noon.getTime() + 8 * hour)

    await server.client.chats.mute({ chatIds: [rex.chatId, ana.chatId], duration: '1d' })
    expect(await mutes(server)).toEqual({ [rex.chatId]: noon.getTime() + 24 * hour, [ana.chatId]: noon.getTime() + 24 * hour })

    await server.client.chats.mute({ chatIds: [ana.chatId], duration: 'forever' })
    expect((await mutes(server))[ana.chatId]).toBe('forever')
  })

  it('ends on time', async () => {
    const { server, rex, ana } = await twoBots()
    await server.client.chats.mute({ chatIds: [rex.chatId], duration: '1h' })
    await server.client.chats.mute({ chatIds: [ana.chatId], duration: 'forever' })

    await server.clock.advance(hour - 1)
    let chats = await server.client.chats.list()
    expect(chats.map((chat) => isMuted(chat, server.clock.now()))).toEqual([true, true])

    await server.clock.advance(1)
    chats = await server.client.chats.list()
    expect(chats.map((chat) => chat.mutedUntil)).toEqual([null, 'forever'])
    expect(chats.map((chat) => isMuted(chat, server.clock.now()))).toEqual([false, true])

    await server.clock.advance(365 * 24 * hour)
    expect((await mutes(server))[ana.chatId]).toBe('forever')
  })

  it('a client holding a muted chat sees its mute end on time, without asking again', async () => {
    const { server, rex } = await twoBots()
    const [chat] = (await server.client.chats.mute({ chatIds: [rex.chatId], duration: '8h' })).filter((each) => each.id === rex.chatId)

    expect(isMuted(chat!, noon.getTime() + 8 * hour - 1)).toBe(true)
    expect(isMuted(chat!, noon.getTime() + 8 * hour)).toBe(false)
  })

  it('unmute, whatever the mute', async () => {
    const { server, rex, ana } = await twoBots()
    await server.client.chats.mute({ chatIds: [rex.chatId], duration: '1d' })
    await server.client.chats.mute({ chatIds: [ana.chatId], duration: 'forever' })

    const chats = await server.client.chats.unmute({ chatIds: [rex.chatId, ana.chatId] })

    expect(chats.map((chat) => chat.mutedUntil)).toEqual([null, null])
    expect(await mutes(server)).toEqual({ [rex.chatId]: null, [ana.chatId]: null })
  })

  it('count a hidden chat as muted, keeping its own mute for when it is shown', async () => {
    const { server, rex, ana } = await twoBots()
    await server.client.chats.mute({ chatIds: [ana.chatId], duration: '1h' })
    await server.client.chats.hide({ chatIds: [rex.chatId, ana.chatId] })

    let chats = await server.client.chats.list()
    expect(chats.map((chat) => [chat.mutedUntil, isMuted(chat, server.clock.now())])).toEqual([
      [null, true],
      [noon.getTime() + hour, true],
    ])

    await server.client.chats.show({ chatIds: [rex.chatId, ana.chatId] })
    chats = await server.client.chats.list()
    expect(chats.map((chat) => isMuted(chat, server.clock.now()))).toEqual([false, true])
  })

  it('keep a mute across a restart', async () => {
    const { server, rex, ana } = await twoBots()
    await server.client.chats.mute({ chatIds: [rex.chatId], duration: '8h' })
    await server.client.chats.mute({ chatIds: [ana.chatId], duration: 'forever' })

    const restarted = await restartTestServer(server)
    servers.push(restarted)

    expect(await mutes(restarted)).toEqual({ [rex.chatId]: noon.getTime() + 8 * hour, [ana.chatId]: 'forever' })
  })

  it('refuse an unknown chat or duration, muting none of the chats asked', async () => {
    const { server, rex } = await twoBots()

    await expect(server.client.chats.mute({ chatIds: [rex.chatId, 'nope'], duration: '1h' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.chats.unmute({ chatIds: ['nope'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // @ts-expect-error: not a duration the owner can pick
    await expect(server.client.chats.mute({ chatIds: [rex.chatId], duration: '2h' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect((await mutes(server))[rex.chatId]).toBe(null)
  })

  it('tell every tab when a chat is muted or unmuted', async () => {
    const { server, rex } = await twoBots()
    const controller = new AbortController()
    const stream = await server.client.events(undefined, { signal: controller.signal })
    await stream.next() // hello

    await server.client.chats.mute({ chatIds: [rex.chatId], duration: 'forever' })
    await server.client.chats.unmute({ chatIds: [rex.chatId] })

    const seen: unknown[] = []
    while (seen.length < 2) {
      const { done, value } = await stream.next()
      if (done) throw new Error('The event stream ended')
      const event: LiveEvent = value.event
      if (event.type === 'chat.updated') seen.push([event.chat.id, event.chat.mutedUntil])
    }
    controller.abort()
    expect(seen).toEqual([
      [rex.chatId, 'forever'],
      [rex.chatId, null],
    ])
  })
})
