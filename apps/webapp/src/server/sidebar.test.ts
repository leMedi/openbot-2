import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo, ChatInfo, LiveEvent, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = {
  name: 'Rex',
  title: 'Builder',
  instructions: '',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
}

async function startWithRex() {
  const server = await createTestServer()
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bot = await server.client.bots.create(rex)
  return { server, bot }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

const chatOf = async (server: TestServer, bot: BotInfo) => (await server.client.chats.list()).find((chat) => chat.id === bot.chatId)!

/** Rex answers the owner's `text` with `reply`. */
async function rexReplies(server: TestServer, bot: BotInfo, text: string, reply: string) {
  server.providers.script(callsTools(['sendMessage', { text: reply }]), endsSilently())
  await server.client.chats.send({ chatId: bot.chatId, text })
  await untilIdle(server, bot)
}

describe('unread chats', () => {
  it('lists a new DM as read, unpinned and waiting for nothing', async () => {
    const { server, bot } = await startWithRex()

    expect(await server.client.chats.list()).toEqual([
      {
        id: bot.chatId,
        kind: 'dm',
        botId: bot.id,
        name: null,
        title: null,
        members: [],
        speaking: null,
        pinnedPosition: null,
        unread: false,
        waitingFor: null,
        lastMessage: null,
      },
    ])
  })

  it("shows a chat unread once its bot posts, but not for the owner's own messages", async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(endsSilently())
    await server.client.chats.send({ chatId: bot.chatId, text: 'Hi' })
    await untilIdle(server, bot)
    expect(await chatOf(server, bot)).toMatchObject({ unread: false, lastMessage: { author: 'owner', text: 'Hi' } })

    await rexReplies(server, bot, 'Fix the build', 'Done, it is green.')

    expect(await chatOf(server, bot)).toMatchObject({
      unread: true,
      lastMessage: { author: 'bot', authorName: 'Rex', text: 'Done, it is green.' },
    })
  })

  it('opening a chat marks it read, until the bot posts again', async () => {
    const { server, bot } = await startWithRex()
    await rexReplies(server, bot, 'Fix the build', 'Done.')

    expect(await server.client.chats.read({ chatId: bot.chatId })).toMatchObject({ id: bot.chatId, unread: false })
    expect(await chatOf(server, bot)).toMatchObject({ unread: false })

    await rexReplies(server, bot, 'And the tests?', 'Green too.')
    expect(await chatOf(server, bot)).toMatchObject({ unread: true })
  })

  it('never moves read state back, so a tab that saw less leaves newer messages read', async () => {
    const { server, bot } = await startWithRex()
    await rexReplies(server, bot, 'Fix the build', 'Done.')
    const seenByOldTab = (await server.client.chats.messages({ chatId: bot.chatId })).at(-1)!.id
    await rexReplies(server, bot, 'And the tests?', 'Green too.')

    await server.client.chats.read({ chatId: bot.chatId, upTo: seenByOldTab })
    expect(await chatOf(server, bot)).toMatchObject({ unread: true })

    await server.client.chats.read({ chatId: bot.chatId })
    await server.client.chats.read({ chatId: bot.chatId, upTo: seenByOldTab })
    expect(await chatOf(server, bot)).toMatchObject({ unread: false })
  })

  it('refuses to mark a chat that does not exist', async () => {
    const { server } = await startWithRex()
    await expect(server.client.chats.read({ chatId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('waiting for the owner', () => {
  it('shows the open question the bot waits on, until the owner answers it', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['askQuestion', { prompt: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }]))
    await server.client.chats.send({ chatId: bot.chatId, text: 'Set up storage' })
    await untilIdle(server, bot)
    expect(await chatOf(server, bot)).toMatchObject({ waitingFor: 'Which database?', unread: true })

    const card = (await server.client.chats.messages({ chatId: bot.chatId })).at(-1)!
    server.providers.script(endsSilently())
    await server.client.chats.answer({ messageId: card.id, answer: { option: 0 } })
    await untilIdle(server, bot)

    expect(await chatOf(server, bot)).toMatchObject({ waitingFor: null })
  })
})

describe('pinning', () => {
  async function threeBots() {
    const { server, bot: rexBot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })
    const max = await server.client.bots.create({ ...rex, name: 'Max' })
    return { server, rex: rexBot, ana, max }
  }

  const pinned = async (server: TestServer) =>
    Object.fromEntries((await server.client.chats.list()).map((chat) => [chat.id, chat.pinnedPosition]))

  it("keeps pinned chats in the owner's order, and unpins the ones left out", async () => {
    const { server, rex, ana, max } = await threeBots()

    await server.client.chats.setPinned({ chatIds: [max.chatId, rex.chatId] })
    expect(await pinned(server)).toEqual({ [rex.chatId]: 1, [ana.chatId]: null, [max.chatId]: 0 })

    // Dragging Rex above Max, then unpinning Max.
    await server.client.chats.setPinned({ chatIds: [rex.chatId, max.chatId] })
    const after = await server.client.chats.setPinned({ chatIds: [rex.chatId] })
    expect(Object.fromEntries(after.map((chat) => [chat.id, chat.pinnedPosition]))).toEqual({
      [rex.chatId]: 0,
      [ana.chatId]: null,
      [max.chatId]: null,
    })
  })

  it('keeps the pinned order across a restart', async () => {
    const { server, rex, ana } = await threeBots()
    await server.client.chats.setPinned({ chatIds: [ana.chatId, rex.chatId] })

    const restarted = await restartTestServer(server)
    servers.push(restarted)

    expect((await pinned(restarted))[ana.chatId]).toBe(0)
    expect((await pinned(restarted))[rex.chatId]).toBe(1)
  })

  it('changes nothing when one of the chats does not exist', async () => {
    const { server, rex } = await threeBots()
    await server.client.chats.setPinned({ chatIds: [rex.chatId] })

    await expect(server.client.chats.setPinned({ chatIds: ['nope'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await pinned(server))[rex.chatId]).toBe(0)
  })
})

describe('live sidebar', () => {
  async function subscribe(server: TestServer) {
    const controller = new AbortController()
    const stream = await server.client.events(undefined, { signal: controller.signal })
    await stream.next() // hello
    return {
      /** Reads events until one matches `until`, returning the chat updates among them. */
      async chatUpdates(until: (event: LiveEvent) => boolean) {
        const updates: ChatInfo[] = []
        for (;;) {
          const { done, value } = await stream.next()
          if (done) throw new Error('The event stream ended')
          if (value.event.type === 'chat.updated') updates.push(value.event.chat)
          if (until(value.event)) {
            controller.abort()
            return updates
          }
        }
      },
    }
  }

  it('tells every tab when a chat turns unread, is read, or is pinned', async () => {
    const { server, bot } = await startWithRex()
    const tab = await subscribe(server)

    await rexReplies(server, bot, 'Fix the build', 'Done.')
    await server.client.chats.read({ chatId: bot.chatId })
    await server.client.chats.setPinned({ chatIds: [bot.chatId] })

    const updates = await tab.chatUpdates((event) => event.type === 'chat.updated' && event.chat.pinnedPosition === 0)
    expect(updates.map(({ unread, pinnedPosition, lastMessage }) => [lastMessage?.text, unread, pinnedPosition])).toEqual([
      ['Fix the build', false, null],
      ['Done.', true, null],
      ['Done.', false, null],
      ['Done.', false, 0],
    ])
  })
})
