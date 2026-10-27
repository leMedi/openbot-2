import { callsTools, endsSilently, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import type { TestPage } from '@openbot/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { ScreenHolds } from './screen-holds.ts'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = { name: 'Rex', title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null }

const login = 'https://shop.test/login'
const pages: Record<string, TestPage> = {
  [login]: { title: 'Sign in', elements: [{ role: 'heading', name: 'Sign in' }, { role: 'textbox', name: 'Password' }] },
}

const orders = { goal: 'Open my orders on shop.test and list the latest one', reason: 'The shop needs a signed-in browser', startUrl: login }
const signIn = 'Sign in to shop.test with your account'

async function startWithRex() {
  const server = await createTestServer({ pages })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bot = await server.client.bots.create(rex)
  return { server, bot }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** Rex's session finds a sign-in page and asks for help; the run ends at the card. */
async function stuckAtSignIn() {
  const { server, bot } = await startWithRex()
  server.providers.script(
    callsTools(['use_computer', orders]),
    callsTools(['browser_snapshot', {}]),
    callsTools(['needs_help', { instruction: signIn }]),
  )
  await server.client.chats.send({ chatId: bot.chatId, text: 'What did I order last?' })
  await untilIdle(server, bot)
  const card = (await server.client.chats.messages({ chatId: bot.chatId })).at(-1)!
  return { server, bot, card }
}

describe('a computer-use session stuck on what only the owner can do', () => {
  it('ends with needs_help, and the bot posts a take-over card and its run waits', async () => {
    const { server, bot, card } = await stuckAtSignIn()

    expect(card).toMatchObject({ author: 'bot', authorName: 'Rex', text: signIn, card: { type: 'take_over', instruction: signIn, outcome: null } })
    // The goal stays the bot's; the owner sees the instruction.
    expect(card.card).not.toHaveProperty('goal')
    // Three model calls: the bot, then the session's two. The bot's run ended at the card, without a reply reminder.
    expect(server.providers.requests).toHaveLength(3)
    const chat = (await server.client.chats.list()).find((entry) => entry.id === bot.chatId)!
    expect(chat.waitingFor).toBe(signIn)
  })

  it('gives only the session a needs_help tool, which its prompt asks it to call when stuck', async () => {
    const { server } = await stuckAtSignIn()

    const [first, , last] = server.providers.requests
    expect(first!.tools).not.toContain('needs_help')
    expect(last!.tools).toContain('needs_help')
    expect(JSON.stringify(last)).toContain('call needs_help with one line telling them what to do on the screen')
  })

  it('opens the screen in take-over mode: holding it pauses sessions until it is handed back', async () => {
    const { server, bot } = await startWithRex()
    await server.client.screens.hold({ botId: bot.id })
    server.providers.script(
      callsTools(['use_computer', { goal: 'Look at the sign-in page', reason: 'Testing', startUrl: login }]),
      callsTools(['browser_snapshot', {}]),
      says('It is a sign-in page.'),
      callsTools(['sendMessage', { text: 'It asks me to sign in' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Look at the shop' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(server.computer.calls.filter((call) => call.kind.startsWith('browser.'))).toEqual([])
    expect((await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(true)

    await server.client.screens.release({ botId: bot.id })
    await untilIdle(server, bot)

    expect(server.computer.calls.filter((call) => call.kind.startsWith('browser.'))).toEqual([
      { bot: 'Rex', kind: 'browser.navigate', url: login },
      { bot: 'Rex', kind: 'browser.snapshot' },
    ])
  })

  it('resumes the bot with the outcome when the owner clicks Done, handing the screen back', async () => {
    const { server, bot, card } = await stuckAtSignIn()
    await server.client.screens.hold({ botId: bot.id })
    server.providers.script(
      callsTools(['use_computer', orders]),
      callsTools(['browser_snapshot', {}]),
      says('The latest order is wool socks, $5.'),
      callsTools(['sendMessage', { text: 'Your last order was wool socks' }]),
      endsSilently(),
    )

    const handed = await server.client.chats.handBack({ messageId: card.id, outcome: 'done' })
    await untilIdle(server, bot)

    expect(handed.card).toEqual({ type: 'take_over', instruction: signIn, outcome: 'done' })
    const woken = JSON.stringify(server.providers.requests[3]!.messages.at(-1))
    expect(woken).toContain('they did what you asked (\\"Sign in to shop.test with your account\\")')
    expect(woken).toContain(orders.goal)
    // Handed back: the next session didn't wait for the owner.
    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.at(-1)).toMatchObject({ author: 'bot', text: 'Your last order was wool socks' })
    expect((await server.client.chats.list()).find((entry) => entry.id === bot.chatId)!.waitingFor).toBeNull()
  })

  it('tells the bot when the owner skips the step instead', async () => {
    const { server, bot, card } = await stuckAtSignIn()
    server.providers.script(callsTools(['sendMessage', { text: "OK, I can't see your orders then" }]), endsSilently())

    await server.client.chats.handBack({ messageId: card.id, outcome: 'skipped' })
    await untilIdle(server, bot)

    const woken = JSON.stringify(server.providers.requests[3]!.messages.at(-1))
    expect(woken).toContain("The owner skipped what you asked them to do on your screen")
    expect((await server.client.chats.messages({ chatId: bot.chatId })).at(-2)!.card).toMatchObject({ outcome: 'skipped' })
  })

  it('is handed back once', async () => {
    const { server, bot, card } = await stuckAtSignIn()
    server.providers.script(callsTools(['sendMessage', { text: 'Thanks' }]), endsSilently())

    await server.client.chats.handBack({ messageId: card.id, outcome: 'done' })
    await expect(server.client.chats.handBack({ messageId: card.id, outcome: 'skipped' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await untilIdle(server, bot)
  })

  it("can't be handed back for a message that is no take-over card", async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())
    await server.client.chats.send({ chatId: bot.chatId, text: 'Hi' })
    await untilIdle(server, bot)
    const [mine] = await server.client.chats.messages({ chatId: bot.chatId })

    await expect(server.client.chats.handBack({ messageId: mine!.id, outcome: 'done' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('keeps the bot off its screen while the card waits for the owner', async () => {
    const { server, bot } = await stuckAtSignIn()
    server.providers.script(callsTools(['use_computer', orders]), callsTools(['sendMessage', { text: 'Waiting for you' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Try again' })
    await untilIdle(server, bot)

    const result = server.providers.requests[4]!.messages.at(-1)!
    expect(result).toMatchObject({ role: 'toolResult', toolName: 'use_computer', isError: true })
    expect(JSON.stringify(result)).toContain("The owner hasn't handed your screen back yet")
  })
})

describe('screen holds', () => {
  it('end when not renewed in time, letting waiting sessions go on', async () => {
    const holds = new ScreenHolds(50)
    holds.hold('rex')
    let free = false
    const waiting = holds.whenFree('rex').then(() => (free = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    holds.hold('rex')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(free).toBe(false)
    await waiting
    expect(holds.isHeld('rex')).toBe(false)
  })
})
