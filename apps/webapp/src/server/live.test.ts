import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { NewBot, StampedEvent } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
const subscriptions: AbortController[] = []
afterEach(async () => {
  for (const controller of subscriptions.splice(0)) controller.abort()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = {
  name: 'Rex',
  title: null,
  instructions: '',
  avatarShape: 'blob',
  avatarColor: 'green',
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

/** A tab's event stream: its hello, then the events it receives. */
async function subscribe(server: TestServer, after?: { epoch: string; seq: number }) {
  const controller = new AbortController()
  subscriptions.push(controller)
  const stream = await server.client.events(after, { signal: controller.signal })
  const next = async () => {
    const { done, value } = await stream.next()
    if (done) throw new Error('The event stream ended')
    return value
  }
  const hello = await next()
  return {
    hello,
    /** Reads events until one matches `until`, returning all of them. */
    async read(until: (event: StampedEvent) => boolean) {
      const events: StampedEvent[] = []
      for (;;) {
        const event = await next()
        events.push(event)
        if (until(event)) return events
      }
    },
    close: () => controller.abort(),
  }
}

const idle = (event: StampedEvent) => event.event.type === 'bot.status' && !event.event.working
const messageIds = (events: StampedEvent[]) =>
  events.flatMap((event) => (event.event.type === 'message.created' ? [event.event.message.id] : []))

describe('live sync', () => {
  it('shows two tabs on the same DM the same messages, once each', async () => {
    const { server, bot } = await startWithRex()
    const [first, second] = [await subscribe(server), await subscribe(server)]
    server.providers.script(callsTools(['sendMessage', { text: 'One' }], ['sendMessage', { text: 'Two' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Hi' })
    const [seenByFirst, seenBySecond] = await Promise.all([first.read(idle), second.read(idle)])

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messageIds(seenByFirst)).toEqual(messages.map((message) => message.id))
    expect(messageIds(seenBySecond)).toEqual(messageIds(seenByFirst))
    expect(seenByFirst.map((event) => event.event.type)).toEqual([
      'message.created',
      'bot.status',
      'message.created',
      'message.created',
      'bot.status',
    ])
  })

  it('catches a reconnecting tab up from the last sequence it saw', async () => {
    const { server, bot } = await startWithRex()
    const tab = await subscribe(server)
    const last = { epoch: tab.hello.epoch, seq: tab.hello.seq }
    tab.close()

    server.providers.script(callsTools(['sendMessage', { text: 'While you were away' }]), endsSilently())
    await server.client.chats.send({ chatId: bot.chatId, text: 'Hi' })
    await expect.poll(async () => (await server.client.bots.list())[0]!.working).toBe(false)

    const again = await subscribe(server, last)
    expect(again.hello).toEqual({ ...last, event: { type: 'hello', resumed: true } })
    const missed = await again.read(idle)
    expect(missed.map((event) => event.seq)).toEqual([last.seq + 1, last.seq + 2, last.seq + 3, last.seq + 4])
    expect(messageIds(missed)).toEqual((await server.client.chats.messages({ chatId: bot.chatId })).map((message) => message.id))
  })

  it('tells a tab reconnecting after a restart to refetch', async () => {
    const before = await createTestServer()
    const tab = await subscribe(before)
    tab.close()

    const after = await restartTestServer(before)
    servers.push(after)
    const again = await subscribe(after, { epoch: tab.hello.epoch, seq: tab.hello.seq })

    expect(again.hello.epoch).not.toBe(tab.hello.epoch)
    expect(again.hello.event).toEqual({ type: 'hello', resumed: false })
  })

  it('announces a new bot to every tab', async () => {
    const server = await createTestServer()
    servers.push(server)
    const tab = await subscribe(server)

    const bot = await server.client.bots.create(rex)

    expect(await tab.read((event) => event.event.type === 'bot.created')).toMatchObject([{ event: { type: 'bot.created', bot } }])
  })

  it('shows every tab an edited bot as it is now', async () => {
    const { server, bot } = await startWithRex()
    const tab = await subscribe(server)

    const updated = await server.client.bots.update({ botId: bot.id, name: 'Rexy', title: 'Tester' })

    expect(await tab.read((event) => event.event.type === 'bot.updated')).toMatchObject([{ event: { type: 'bot.updated', bot: updated } }])
  })

  it('tells every tab a bot was deleted', async () => {
    const { server, bot } = await startWithRex()
    const tab = await subscribe(server)

    await server.client.bots.delete({ botId: bot.id })

    expect(await tab.read((event) => event.event.type === 'bot.deleted')).toMatchObject([
      { event: { type: 'bot.deleted', botId: bot.id, chatId: bot.chatId } },
    ])
  })
})
