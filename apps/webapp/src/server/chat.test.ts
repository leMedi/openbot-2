import { replyReminder, steerPending } from '@openbot/agent'
import { callsTools, endsSilently, fails, held, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = {
  name: 'Rex',
  title: 'Builder',
  instructions: 'Rex fixes builds and never gives up.',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
}

/** A finished onboarding: the `fake` provider connected, `fake/fake-model` as default, and Rex. */
async function startWithRex() {
  const server = await createTestServer()
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bot = await server.client.bots.create(rex)
  return { server, bot }
}

/** Waits until the bot has finished working, as the web app sees it. */
async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

const texts = async (server: TestServer, bot: BotInfo) =>
  (await server.client.chats.messages({ chatId: bot.chatId })).map((message) => [message.author, message.text])

describe('chatting in a DM', () => {
  it('replies in several messages through sendMessage, keeping its thinking and tool calls hidden', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      callsTools(['sendMessage', { text: 'On it!' }]),
      callsTools(['sendMessage', { text: 'Here is the fix:\n\n```ts\nconst answer = 42\n```' }]),
      says('Private: I should double-check the build later.'),
    )

    const sent = await server.client.chats.send({ chatId: bot.chatId, text: 'Can you fix the build?' })
    expect(sent).toMatchObject({ author: 'owner', text: 'Can you fix the build?' })
    expect((await server.client.bots.list())[0]!.working).toBe(true)
    await untilIdle(server, bot)

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.map((message) => [message.author, message.authorName, message.text])).toEqual([
      ['owner', 'You', 'Can you fix the build?'],
      ['bot', 'Rex', 'On it!'],
      ['bot', 'Rex', 'Here is the fix:\n\n```ts\nconst answer = 42\n```'],
    ])
    expect(JSON.stringify(messages)).not.toMatch(/Private|sendMessage/)
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('tells the model who the bot is', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Hello' })
    await untilIdle(server, bot)

    const system = JSON.stringify(server.providers.requests[0]!.messages)
    expect(system).toContain('You are Rex, Builder.')
    expect(system).toContain('Rex fixes builds and never gives up.')
  })

  it('runs a bot with no model of its own on the current default model', async () => {
    const { server, bot } = await startWithRex()
    await server.client.models.updateSettings({ defaultModel: 'fake/fake-mini' })
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Hello' })
    await untilIdle(server, bot)

    expect(server.providers.requests.map((request) => request.model)).toEqual(['fake/fake-mini', 'fake/fake-mini'])
  })

  it('runs a bot with its own model on that model', async () => {
    const { server } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', model: 'fake/fake-mini' })
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())

    await server.client.chats.send({ chatId: ana.chatId, text: 'Hello' })
    await untilIdle(server, ana)

    expect(server.providers.requests.map((request) => request.model)).toEqual(['fake/fake-mini', 'fake/fake-mini'])
  })

  it('moves every bot without a model of its own to a new default model, and only those', async () => {
    const { server, bot: rexBot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', model: 'fake/fake-model' })
    const kim = await server.client.bots.create({ ...rex, name: 'Kim', model: 'fake/fake-model' })
    await server.client.bots.update({ botId: kim.id, model: null })

    await server.client.models.updateSettings({ defaultModel: 'fake/fake-mini' })
    for (const bot of [rexBot, ana, kim]) {
      server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())
      await server.client.chats.send({ chatId: bot.chatId, text: 'Hello' })
      await untilIdle(server, bot)
    }

    expect(server.providers.requests.map((request) => request.model)).toEqual([
      ...['fake/fake-mini', 'fake/fake-mini'],
      ...['fake/fake-model', 'fake/fake-model'],
      ...['fake/fake-mini', 'fake/fake-mini'],
    ])
  })

  it('runs an edited bot as it is now', async () => {
    const { server, bot } = await startWithRex()
    await server.client.bots.update({ botId: bot.id, name: 'Rexy', title: 'Tester', instructions: 'Rexy writes tests first.' })
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Hello' })
    await untilIdle(server, bot)

    const system = JSON.stringify(server.providers.requests[0]!.messages)
    expect(system).toContain('You are Rexy, Tester.')
    expect(system).toContain('Rexy writes tests first.')
    expect(system).not.toContain('Rex fixes builds')
    expect((await server.client.chats.messages({ chatId: bot.chatId })).at(-1)).toMatchObject({ authorName: 'Rexy' })
  })

  it('gives bots no tool to delete a bot', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Delete yourself' })
    await untilIdle(server, bot)

    const tools = server.providers.requests[0]!.tools
    expect(tools).toContain('sendMessage')
    // message_bot only messages a teammate.
    expect(tools.filter((tool) => tool !== 'message_bot' && /delete|remove|bot/i.test(tool))).toEqual([])
  })

  it("refuses the owner's message, without posting it, when the bot's model is unavailable", async () => {
    const { server, bot } = await startWithRex()
    await server.client.providers.disconnect({ providerId: 'fake' })

    await expect(server.client.chats.send({ chatId: bot.chatId, text: 'Hello?' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(await server.client.chats.messages({ chatId: bot.chatId })).toEqual([])
  })

  it('keeps one history per bot across messages', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['sendMessage', { text: 'One' }]), endsSilently())
    await server.client.chats.send({ chatId: bot.chatId, text: 'First' })
    await untilIdle(server, bot)

    server.providers.script(callsTools(['sendMessage', { text: 'Two' }]), endsSilently())
    await server.client.chats.send({ chatId: bot.chatId, text: 'Second' })
    await untilIdle(server, bot)

    const lastRequest = JSON.stringify(server.providers.requests.at(-2)!.messages)
    expect(lastRequest).toContain('First')
    expect(lastRequest).toContain('Second')
  })

  it("keeps the bot's history across a restart", async () => {
    const { server: before, bot } = await startWithRex()
    before.providers.script(callsTools(['sendMessage', { text: 'One' }]), endsSilently())
    await before.client.chats.send({ chatId: bot.chatId, text: 'Remember the word banana' })
    await untilIdle(before, bot)

    const after = await restartTestServer(before)
    servers.splice(servers.indexOf(before), 1, after)
    after.providers.script(callsTools(['sendMessage', { text: 'banana' }]), endsSilently())
    await after.client.chats.send({ chatId: bot.chatId, text: 'What was the word?' })
    await untilIdle(after, bot)

    expect(JSON.stringify(after.providers.requests[0]!.messages)).toContain('Remember the word banana')
    expect(await texts(after, bot)).toEqual([
      ['owner', 'Remember the word banana'],
      ['bot', 'One'],
      ['owner', 'What was the word?'],
      ['bot', 'banana'],
    ])
  })
})

describe('a failing model', () => {
  it('tells the owner the bot could not reach its model, until a later run succeeds', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(fails('401 Unauthorized: invalid API key'))

    await server.client.chats.send({ chatId: bot.chatId, text: 'Hello?' })
    await untilIdle(server, bot)

    expect((await server.client.bots.list())[0]!.error).toMatch(/invalid API key/)
    expect(await texts(server, bot)).toEqual([['owner', 'Hello?']])

    server.providers.script(callsTools(['sendMessage', { text: 'Back!' }]), endsSilently())
    await server.client.chats.send({ chatId: bot.chatId, text: 'And now?' })
    await untilIdle(server, bot)

    expect((await server.client.bots.list())[0]!.error).toBeNull()
  })
})

describe('the reply guarantee', () => {
  it('reminds a bot that answered the owner without a message, until it replies', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      says('Private: the build is green, nothing to say.'),
      callsTools(['sendMessage', { text: 'The build is green again.' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'How is the build?' })
    await untilIdle(server, bot)

    expect(await texts(server, bot)).toEqual([
      ['owner', 'How is the build?'],
      ['bot', 'The build is green again.'],
    ])
    expect(JSON.stringify(server.providers.requests[1]!.messages)).toContain(replyReminder)
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('does not count a message that failed to send as a reply', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      callsTools(['sendMessage', {}]),
      endsSilently(),
      callsTools(['sendMessage', { text: 'Sorry, here it is.' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Ping' })
    await untilIdle(server, bot)

    expect(await texts(server, bot)).toEqual([
      ['owner', 'Ping'],
      ['bot', 'Sorry, here it is.'],
    ])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('does not remind a bot that already replied', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['sendMessage', { text: 'Done.' }]), says('Private: all good.'), says('unused'))

    await server.client.chats.send({ chatId: bot.chatId, text: 'Ping' })
    await untilIdle(server, bot)

    expect(server.providers.pendingTurns).toBe(1)
  })

  it('gives up after three reminders', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(endsSilently(), endsSilently(), endsSilently(), endsSilently(), says('unused'))

    await server.client.chats.send({ chatId: bot.chatId, text: 'Ping' })
    await untilIdle(server, bot)

    expect(server.providers.requests).toHaveLength(4)
    expect(server.providers.pendingTurns).toBe(1)
  })
})

describe('steering', () => {
  it("delivers a message sent while the bot works to its current run, holding back its answer to the old request", async () => {
    const { server, bot } = await startWithRex()
    const stale = held(callsTools(['sendMessage', { text: 'Done, I fixed it with npm.' }]))
    server.providers.script(stale, callsTools(['sendMessage', { text: 'Switching to pnpm.' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Fix the build' })
    await stale.requested
    await server.client.chats.send({ chatId: bot.chatId, text: 'Use pnpm, not npm' })
    stale.release()
    await untilIdle(server, bot)

    expect(await texts(server, bot)).toEqual([
      ['owner', 'Fix the build'],
      ['owner', 'Use pnpm, not npm'],
      ['bot', 'Switching to pnpm.'],
    ])
    // One run: the steer joined it after the held-back message, instead of starting a run of its own.
    expect(server.providers.requests).toHaveLength(3)
    const steered = JSON.stringify(server.providers.requests[1]!.messages)
    expect(steered).toContain('Done, I fixed it with npm.')
    expect(steered).toContain(steerPending)
    expect(steered).toContain('Use pnpm, not npm')
    expect(server.providers.pendingTurns).toBe(0)
  })
})

describe('stopping', () => {
  it('aborts the current run, leaving the bot idle and ready for the next message', async () => {
    const { server, bot } = await startWithRex()
    const runaway = held(callsTools(['sendMessage', { text: 'Still deleting files…' }]))
    server.providers.script(runaway)

    await server.client.chats.send({ chatId: bot.chatId, text: 'Clean up the disk' })
    await runaway.requested
    await server.client.bots.stop({ botId: bot.id })

    const [stopped] = await server.client.bots.list()
    expect(stopped).toMatchObject({ working: false, error: null })
    expect(await texts(server, bot)).toEqual([['owner', 'Clean up the disk']])

    server.providers.script(callsTools(['sendMessage', { text: 'Stopped. What next?' }]), endsSilently())
    await server.client.chats.send({ chatId: bot.chatId, text: 'Sorry, wrong disk' })
    await untilIdle(server, bot)
    expect((await texts(server, bot)).at(-1)).toEqual(['bot', 'Stopped. What next?'])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('does nothing to an idle bot', async () => {
    const { server, bot } = await startWithRex()

    await server.client.bots.stop({ botId: bot.id })

    expect((await server.client.bots.list())[0]).toMatchObject({ working: false, error: null })
  })

  it('refuses an unknown bot', async () => {
    const { server } = await startWithRex()

    await expect(server.client.bots.stop({ botId: 'nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
