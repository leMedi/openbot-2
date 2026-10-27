import { callsTools, endsSilently, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

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

const whichDatabase = {
  prompt: 'Which database should I use?',
  details: 'Both work; Postgres needs a server.',
  options: [
    { label: 'SQLite', description: 'One file, no server', style: 'primary' },
    { label: 'Postgres' },
    { label: 'Drop the data', style: 'danger' },
  ],
}

/** Rex asks `question` in answer to the owner's message, and the run ends there. */
async function askedByRex(question: Record<string, unknown> = whichDatabase) {
  const { server, bot } = await startWithRex()
  server.providers.script(callsTools(['askQuestion', question as never]))
  await server.client.chats.send({ chatId: bot.chatId, text: 'Set up storage for the app' })
  await untilIdle(server, bot)
  const card = (await server.client.chats.messages({ chatId: bot.chatId })).at(-1)!
  return { server, bot, card }
}

describe('asking the owner a question', () => {
  it('posts a question card with its options, and asking ends the run', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['askQuestion', whichDatabase as never]), says('unused'))

    await server.client.chats.send({ chatId: bot.chatId, text: 'Set up storage for the app' })
    await untilIdle(server, bot)

    const card = (await server.client.chats.messages({ chatId: bot.chatId })).at(-1)

    expect(card).toMatchObject({
      author: 'bot',
      authorName: 'Rex',
      card: {
        type: 'question',
        prompt: 'Which database should I use?',
        details: 'Both work; Postgres needs a server.',
        options: [
          { label: 'SQLite', description: 'One file, no server', style: 'primary' },
          { label: 'Postgres', description: null, style: 'default' },
          { label: 'Drop the data', description: null, style: 'danger' },
        ],
        allowText: false,
        answer: null,
      },
    })
    // No further model call: the run ended at the question, without a reply reminder.
    expect(server.providers.requests).toHaveLength(1)
    expect(server.providers.pendingTurns).toBe(1)
  })

  it('ends the run when the bot sends a message and asks in the same breath', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      callsTools(['sendMessage', { text: 'Quick one before I start.' }], ['askQuestion', whichDatabase as never]),
      says('unused'),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Set up storage for the app' })
    await untilIdle(server, bot)

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.map((message) => [message.text, message.card?.type ?? null])).toEqual([
      ['Set up storage for the app', null],
      ['Quick one before I start.', null],
      ['Which database should I use?', 'question'],
    ])
    expect(server.providers.requests).toHaveLength(1)
  })

  it('refuses a question with no options or more than six', async () => {
    const { server, bot } = await startWithRex()
    const seven = Array.from({ length: 7 }, (_, index) => ({ label: `Option ${index + 1}` }))
    server.providers.script(
      callsTools(['askQuestion', { prompt: 'Pick one', options: [] }]),
      callsTools(['askQuestion', { prompt: 'Pick one', options: seven }]),
      callsTools(['sendMessage', { text: 'Never mind.' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Choose for me' })
    await untilIdle(server, bot)

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.map((message) => [message.text, message.card])).toEqual([
      ['Choose for me', null],
      ['Never mind.', null],
    ])
  })
})

describe('answering a question', () => {
  it('shows the chosen option and wakes the bot with it', async () => {
    const { server, bot, card } = await askedByRex()
    server.providers.script(callsTools(['sendMessage', { text: 'SQLite it is.' }]), endsSilently())

    const answered = await server.client.chats.answer({ messageId: card.id, answer: { option: 0 } })
    expect(answered.card).toMatchObject({ type: 'question', answer: { option: 0 } })
    await untilIdle(server, bot)

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.at(-2)!.card).toMatchObject({ answer: { option: 0 } })
    expect(messages.at(-1)).toMatchObject({ author: 'bot', text: 'SQLite it is.' })
    const woken = JSON.stringify(server.providers.requests[1]!.messages)
    expect(woken).toContain('Which database should I use?')
    expect(woken).toContain('SQLite')
  })

  it("can't be answered twice", async () => {
    const { server, bot, card } = await askedByRex()
    server.providers.script(callsTools(['sendMessage', { text: 'Postgres it is.' }]), endsSilently())

    await server.client.chats.answer({ messageId: card.id, answer: { option: 1 } })
    await expect(server.client.chats.answer({ messageId: card.id, answer: { option: 0 } })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await untilIdle(server, bot)

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.find((message) => message.id === card.id)!.card).toMatchObject({ answer: { option: 1 } })
  })

  it('accepts a free-text answer only when the card allows it', async () => {
    const { server, bot, card } = await askedByRex({ ...whichDatabase, allowText: true })
    expect(card.card).toMatchObject({ allowText: true })
    server.providers.script(callsTools(['sendMessage', { text: 'MySQL then.' }]), endsSilently())

    await server.client.chats.answer({ messageId: card.id, answer: { text: '  MySQL, we already run it  ' } })
    await untilIdle(server, bot)

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.find((message) => message.id === card.id)!.card).toMatchObject({
      answer: { text: 'MySQL, we already run it' },
    })
    expect(JSON.stringify(server.providers.requests[1]!.messages)).toContain('MySQL, we already run it')
  })

  it('refuses a free-text answer on a card that does not allow one, and an option it does not have', async () => {
    const { server, card } = await askedByRex()

    await expect(server.client.chats.answer({ messageId: card.id, answer: { text: 'MySQL' } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(server.client.chats.answer({ messageId: card.id, answer: { option: 3 } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    const [, question] = await server.client.chats.messages({ chatId: card.chatId })
    expect(question!.card).toMatchObject({ answer: null })
  })

  it('refuses a message that is not a question', async () => {
    const { server, bot } = await startWithRex()
    const sent = await server.client.chats.send({ chatId: bot.chatId, text: 'Hi' })

    await expect(server.client.chats.answer({ messageId: sent.id, answer: { option: 0 } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(server.client.chats.answer({ messageId: 'nothing', answer: { option: 0 } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('tells every open tab about the answer', async () => {
    const { server, bot, card } = await askedByRex()
    const stream = await server.client.events()
    await stream.next() // hello
    server.providers.script(callsTools(['sendMessage', { text: 'OK.' }]), endsSilently())

    await server.client.chats.answer({ messageId: card.id, answer: { option: 2 } })

    for (;;) {
      const { done, value } = await stream.next()
      if (done) throw new Error('The event stream ended')
      if (value.event.type !== 'message.updated') continue
      expect(value.event.message).toMatchObject({ id: card.id, card: { answer: { option: 2 } } })
      break
    }
    await stream.return(undefined)
    await untilIdle(server, bot)
  })
})
