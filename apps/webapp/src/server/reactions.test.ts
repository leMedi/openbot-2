import { groupReplyReminder, replyReminder } from '@openbot/agent'
import { callsTools, endsSilently, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const profile = (name: string): NewBot => ({ name, title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })

async function startWith(...names: string[]) {
  const server = await createTestServer()
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bots: BotInfo[] = []
  for (const name of names) bots.push(await server.client.bots.create(profile(name)))
  return { server, bots }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** The owner says `text` to `bot`, which answers `answer`; returns the owner's and the bot's messages. */
async function exchange(server: TestServer, bot: BotInfo, text: string, answer: string) {
  server.providers.script(callsTools(['sendMessage', { text: answer }]), endsSilently())
  const sent = await server.client.chats.send({ chatId: bot.chatId, text })
  await untilIdle(server, bot)
  const reply = (await server.messages(bot.chatId)).at(-1)!
  return { sent, reply }
}

/** What the model read last, as text. */
const lastRead = (server: TestServer) => JSON.stringify(server.providers.requests.at(-1)!.messages.at(-1))

describe('reactions', () => {
  it("toggles the owner's reaction on a message, telling every tab", async () => {
    const { server, bots } = await startWith('Rex')
    const { reply } = await exchange(server, bots[0]!, 'Ship it?', 'Shipped.')
    server.providers.script(endsSilently(), endsSilently())
    const stream = await server.client.events()
    await stream.next() // hello

    const added = await server.client.chats.react({ messageId: reply.id, emoji: '👍' })
    expect(added.reactions).toEqual([{ emoji: '👍', by: 'owner' }])
    await untilIdle(server, bots[0]!)
    const both = await server.client.chats.react({ messageId: reply.id, emoji: '🎉' })
    expect(both.reactions.map((entry) => entry.emoji)).toEqual(['👍', '🎉'])
    await untilIdle(server, bots[0]!)
    const removed = await server.client.chats.react({ messageId: reply.id, emoji: '👍' })
    expect(removed.reactions).toEqual([{ emoji: '🎉', by: 'owner' }])

    expect((await server.messages(bots[0]!.chatId)).at(-1)!.reactions).toEqual([{ emoji: '🎉', by: 'owner' }])
    const told: number[] = []
    while (told.length < 3) {
      const { done, value } = await stream.next()
      if (done) throw new Error('The event stream ended')
      if (value.event.type === 'message.updated' && value.event.message.id === reply.id) told.push(value.event.message.reactions.length)
    }
    await stream.return(undefined)
    expect(told).toEqual([1, 2, 1])
  })

  it("wakes the bot whose message the owner reacted to, asking for no reply", async () => {
    const { server, bots } = await startWith('Rex')
    const { reply } = await exchange(server, bots[0]!, 'Ship it?', 'Shipped the release to everyone   \n on the beta channel, and the notes are up too, with screenshots.')
    server.providers.script(endsSilently())
    const before = server.providers.requests.length

    await server.client.chats.react({ messageId: reply.id, emoji: '🎉' })
    await expect.poll(() => server.providers.requests.length).toBe(before + 1)
    await untilIdle(server, bots[0]!)

    expect(lastRead(server)).toContain(
      '[The owner reacted 🎉 to your message: \\"Shipped the release to everyone on the beta channel, and the notes are up too, w…\\". ' +
        "You don't need to reply; act on it only if it's useful (e.g. acknowledge, adjust, or continue).]",
    )
    // Ending silently is a complete answer to a reaction.
    expect(server.providers.requests).toHaveLength(before + 1)
    expect(JSON.stringify(server.providers.requests.at(-1))).not.toContain(replyReminder)
    expect((await server.messages(bots[0]!.chatId)).map((message) => message.text)).toEqual(['Ship it?', reply.text])
  })

  it("wakes nobody when the owner takes a reaction back or reacts to their own message", async () => {
    const { server, bots } = await startWith('Rex')
    const { sent, reply } = await exchange(server, bots[0]!, 'Ship it?', 'Shipped.')
    server.providers.script(endsSilently())
    await server.client.chats.react({ messageId: reply.id, emoji: '👍' })
    await untilIdle(server, bots[0]!)
    const before = server.providers.requests.length

    await server.client.chats.react({ messageId: reply.id, emoji: '👍' })
    const own = await server.client.chats.react({ messageId: sent.id, emoji: '😂' })

    expect(own.reactions).toEqual([{ emoji: '😂', by: 'owner' }])
    await untilIdle(server, bots[0]!)
    expect(server.providers.requests).toHaveLength(before)
  })

  it('refuses anything but one emoji, and a message that is not there', async () => {
    const { server, bots } = await startWith('Rex')
    const { reply } = await exchange(server, bots[0]!, 'Ship it?', 'Shipped.')

    for (const emoji of ['ok', '👍👍', 'a👍']) {
      await expect(server.client.chats.react({ messageId: reply.id, emoji })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
    for (const emoji of ['❤️', '👍🏽', '🇫🇷', '👨‍👩‍👧']) await server.client.chats.react({ messageId: reply.id, emoji })
    await expect(server.client.chats.react({ messageId: 'nothing', emoji: '👍' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("wakes the member who wrote a group's message, in a turn of that group", async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', callsTools(['sendMessage', { text: 'Rex here.' }]), endsSilently())
    server.providers.scriptFor('Ana', endsSilently())
    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Morning' })
    await server.rounds.idle(chat.id)
    const rexs = (await server.messages(chat.id)).find((message) => message.authorName === 'Rex')!
    // Text it doesn't send: after a reaction, no reminder asks it to post.
    server.providers.scriptFor('Rex', says('Nice, they liked it.'), endsSilently())
    const before = server.providers.requests.length

    await server.client.chats.react({ messageId: rexs.id, emoji: '❤️' })
    await expect.poll(() => server.providers.requests.length).toBe(before + 1)
    await untilIdle(server, rex!)

    const read = lastRead(server)
    expect(read).toContain('[Group chat: \\"Rex, Ana\\" - with Ana]')
    expect(read).toContain('[The owner reacted ❤️ to your message: \\"Rex here.\\".')
    expect(JSON.stringify(server.providers.requests.at(-1))).toContain('You are Rex')
    expect(server.providers.requests).toHaveLength(before + 1)
    expect(JSON.stringify(server.providers.requests.at(-1))).not.toContain(groupReplyReminder)
    expect(server.providers.pendingTurns).toBe(1)
  })
})

describe('replies', () => {
  it("shows what the owner's message replies to, and gives the bot the quote before their text", async () => {
    const { server, bots } = await startWith('Rex')
    const { reply } = await exchange(server, bots[0]!, 'Ship it?', 'Shipped to\n\nbeta and stable.')
    server.providers.script(callsTools(['sendMessage', { text: 'Sure.' }]), endsSilently())

    const sent = await server.client.chats.send({ chatId: bots[0]!.chatId, text: 'Roll back stable', replyToId: reply.id })
    await untilIdle(server, bots[0]!)

    const replyTo = { id: reply.id, author: 'bot', botId: bots[0]!.id, authorName: 'Rex', text: 'Shipped to beta and stable.' }
    expect(sent.replyTo).toEqual(replyTo)
    expect((await server.messages(bots[0]!.chatId)).find((message) => message.id === sent.id)!.replyTo).toEqual(replyTo)
    const address = `m${reply.id.slice(-8)}`
    expect(JSON.stringify(server.providers.requests.at(-2)!.messages.at(-1))).toContain(
      `[m${sent.id.slice(-8)}]\\n[In reply to ${address}: \\"Shipped to beta and stable.\\"]\\nRoll back stable`,
    )
  })

  it('quotes a group message in the turns of the members reading it', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', callsTools(['sendMessage', { text: 'Rex here.' }]), endsSilently())
    server.providers.scriptFor('Ana', endsSilently())
    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Morning' })
    await server.rounds.idle(chat.id)
    const rexs = (await server.messages(chat.id)).find((message) => message.authorName === 'Rex')!
    server.providers.scriptFor('Rex', endsSilently())
    server.providers.scriptFor('Ana', endsSilently())

    const sent = await server.client.chats.send({ chatId: chat.id, text: 'Why?', replyToId: rexs.id })
    await server.rounds.idle(chat.id)

    expect(sent.replyTo).toMatchObject({ id: rexs.id, authorName: 'Rex', text: 'Rex here.' })
    const read = JSON.stringify(server.providers.requests.at(-1)!.messages.at(-1))
    expect(read).toContain(`The owner [m${sent.id.slice(-8)}]: [In reply to m${rexs.id.slice(-8)}: \\"Rex here.\\"] Why?`)
  })

  it("refuses to reply to a message of another chat", async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const { reply } = await exchange(server, rex!, 'Ship it?', 'Shipped.')

    await expect(server.client.chats.send({ chatId: ana!.chatId, text: 'Hm', replyToId: reply.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.chats.send({ chatId: rex!.chatId, text: 'Hm', replyToId: 'nothing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe("bots' reactions", () => {
  it("lets a bot react to the owner's message by its address, as a complete answer, and take it back", async () => {
    const { server, bots } = await startWith('Rex')
    const { sent } = await exchange(server, bots[0]!, 'Hi', 'Hey!')
    const address = `m${sent.id.slice(-8)}`
    server.providers.script(callsTools(['react', { message: address, emoji: '😂' }]), endsSilently())

    await server.client.chats.send({ chatId: bots[0]!.chatId, text: 'Ha, that went well' })
    await untilIdle(server, bots[0]!)

    expect((await server.messages(bots[0]!.chatId))[0]!.reactions).toEqual([{ emoji: '😂', by: bots[0]!.id }])
    // Reacting was its whole answer: no reminder to reply followed.
    expect(JSON.stringify(server.providers.requests.at(-1))).not.toContain(replyReminder)
    expect(JSON.stringify(server.providers.requests.at(-1)!.messages.at(-1))).toContain(`Reacted 😂 on ${address}`)
    expect(server.providers.pendingTurns).toBe(0)

    server.providers.script(callsTools(['react', { message: `[${address}]`, emoji: '😂' }], ['sendMessage', { text: 'Ok' }]), endsSilently())
    await server.client.chats.send({ chatId: bots[0]!.chatId, text: 'Never mind' })
    await untilIdle(server, bots[0]!)
    expect((await server.messages(bots[0]!.chatId))[0]!.reactions).toEqual([])
  })

  it("can't react to its own messages, an address it doesn't know, or with more than an emoji", async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const { reply } = await exchange(server, rex!, 'Hi', 'Hey!')
    const { sent: toAna } = await exchange(server, ana!, 'Hi Ana', 'Hello!')
    const tries = [
      { message: `m${reply.id.slice(-8)}`, emoji: '👍' },
      { message: `m${toAna.id.slice(-8)}`, emoji: '👍' },
      { message: 'mzzzz', emoji: '👍' },
      { message: `m${(await server.messages(rex!.chatId))[0]!.id.slice(-8)}`, emoji: 'nice' },
    ]
    server.providers.script(callsTools(...tries.map((args) => ['react', args] as [string, typeof args])), callsTools(['sendMessage', { text: 'Ok' }]), endsSilently())

    await server.client.chats.send({ chatId: rex!.chatId, text: 'Go on' })
    await untilIdle(server, rex!)

    const results = server.providers.requests.at(-2)!.messages.flatMap((message) => (message.role === 'toolResult' ? [JSON.stringify(message.content)] : []))
    expect(results.slice(-4)).toEqual([
      expect.stringContaining("only the owner's messages"),
      expect.stringContaining("only the owner's messages"),
      expect.stringContaining("only the owner's messages"),
      expect.stringContaining("isn't a single emoji"),
    ])
    for (const message of [...(await server.messages(rex!.chatId)), ...(await server.messages(ana!.chatId))]) expect(message.reactions).toEqual([])
  })
})
