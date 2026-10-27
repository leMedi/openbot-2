import { existsSync } from 'node:fs'
import { callsTools, endsSilently, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import type { Orchestrator } from '@openbot/core'
import type { TestPage } from '@openbot/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer, type TestServerOptions } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = { name: 'Rex', title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null }

const shop = 'https://shop.test/'
const socks = 'https://shop.test/socks'
const pages: Record<string, TestPage> = {
  [shop]: {
    title: 'Shop',
    elements: [
      { role: 'heading', name: 'Shop' },
      { role: 'link', name: 'Socks', href: socks },
      { role: 'textbox', name: 'Search' },
    ],
  },
  [socks]: { title: 'Socks', elements: [{ role: 'heading', name: 'Socks' }, { role: 'text', name: 'Wool socks: $5' }] },
}

const browserTools = ['browser_snapshot', 'browser_navigate', 'browser_click', 'browser_type', 'browser_tabs', 'browser_screenshot']

/** Rex on a server whose default model can't see images, with a computer-use model that can. */
async function startWithRex(options: TestServerOptions = {}) {
  const server = await createTestServer({ pages, ...options })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-mini', computerUseModel: 'fake/fake-model' })
  const bot = await server.client.bots.create(rex)
  return { server, bot }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

const useComputer = {
  goal: 'Find the price of socks on shop.test and tell me',
  reason: 'The shop has no API and its prices are rendered by JavaScript',
  startUrl: shop,
}

/**
 * Rex hands the browser a goal; the session looks, clicks the socks link and answers; Rex then tells the owner. The
 * fake model answers both in one queue, in the order they ask.
 */
async function shopForSocks(server: TestServer, bot: BotInfo) {
  server.providers.script(
    callsTools(['use_computer', useComputer]),
    callsTools(['browser_snapshot', {}]),
    callsTools(['browser_click', { ref: 'e2' }]),
    says('Wool socks cost $5 on shop.test/socks.'),
    callsTools(['sendMessage', { text: 'Socks are $5' }]),
    endsSilently(),
  )
  await server.client.chats.send({ chatId: bot.chatId, text: 'How much are socks at the shop?' })
  await untilIdle(server, bot)
}

describe('computer-use sessions', () => {
  it('complete a browser task and give the bot a summary and a final screenshot, saved in its folder', async () => {
    const { server, bot } = await startWithRex()

    await shopForSocks(server, bot)

    const browsing = server.computer.calls.filter((call) => call.kind.startsWith('browser.'))
    expect(browsing).toEqual([
      { bot: 'Rex', kind: 'browser.navigate', url: shop },
      { bot: 'Rex', kind: 'browser.snapshot' },
      { bot: 'Rex', kind: 'browser.click', ref: 'e2' },
      { bot: 'Rex', kind: 'browser.snapshot' },
      { bot: 'Rex', kind: 'browser.screenshot' },
    ])
    // The session saw the socks page after its click.
    expect(JSON.stringify(server.providers.requests[3]!.messages.at(-1))).toContain('Wool socks: $5')
    const result = server.providers.requests[4]!.messages.at(-1)!
    expect(result).toMatchObject({ role: 'toolResult', toolName: 'use_computer', isError: false })
    const content = JSON.stringify(result)
    expect(content).toContain('Wool socks cost $5 on shop.test/socks.')
    expect(content).not.toContain('"type":"image"')
    const saved = content.match(/saved at (\S+\.png)/)![1]!
    expect(saved.startsWith(`${server.home}/bots/${bot.id}/screenshots/`)).toBe(true)
    expect(existsSync(saved)).toBe(true)
  })

  it('run on the computer-use model, with only the browser tools; the bot never has them', async () => {
    const { server, bot } = await startWithRex()

    await shopForSocks(server, bot)

    const [first, ...rest] = server.providers.requests
    const session = rest.slice(0, 3)
    const after = rest.slice(3)
    expect(first!.model).toBe('fake/fake-mini')
    expect(first!.tools).toContain('use_computer')
    for (const request of [first!, ...after]) {
      expect(request.model).toBe('fake/fake-mini')
      expect(request.tools.filter((tool) => tool.startsWith('browser_'))).toEqual([])
    }
    for (const request of session) {
      expect(request.model).toBe('fake/fake-model')
      expect(request.tools.sort()).toEqual([...browserTools].sort())
    }
  })

  it('run on the default model when no computer-use model is chosen', async () => {
    const { server, bot } = await startWithRex()
    await server.client.models.updateSettings({ defaultModel: 'fake/fake-model', computerUseModel: null })

    await shopForSocks(server, bot)

    expect(server.providers.requests).toHaveLength(6)
    expect(new Set(server.providers.requests.map((request) => request.model))).toEqual(new Set(['fake/fake-model']))
  })

  it("refuse element references from a snapshot that isn't the latest", async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      callsTools(['use_computer', useComputer]),
      callsTools(['browser_snapshot', {}]),
      callsTools(['browser_snapshot', {}]),
      // e2 was the socks link on the first snapshot; the second gave it e5.
      callsTools(['browser_click', { ref: 'e2' }]),
      callsTools(['browser_click', { ref: 'e5' }]),
      says('Socks are $5.'),
      callsTools(['sendMessage', { text: 'Socks are $5' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'How much are socks?' })
    await untilIdle(server, bot)

    const [stale, fresh] = [server.providers.requests[4]!, server.providers.requests[5]!].map((request) => request.messages.at(-1)!)
    expect(stale).toMatchObject({ role: 'toolResult', toolName: 'browser_click', isError: true })
    expect(JSON.stringify(stale)).toContain("e2 isn't on the latest snapshot")
    expect(fresh).toMatchObject({ role: 'toolResult', toolName: 'browser_click', isError: false })
    expect(JSON.stringify(fresh)).toContain('Wool socks: $5')
  })

  it('are written to the audit log with their reason', async () => {
    const { server, bot } = await startWithRex()

    await shopForSocks(server, bot)

    expect((await server.client.bots.audit({ botId: bot.id })).map(({ surface, tool, input }) => ({ surface, tool, input }))).toEqual([
      { surface: 'computer_session', tool: 'use_computer', input: useComputer },
    ])
  })

  it('are reviewed by the orchestrator, which can stop one before it starts', async () => {
    const denyAll: Orchestrator = { review: async () => ({ decision: 'deny', reason: 'No browsing today' }) }
    const { server, bot } = await startWithRex({ orchestrator: denyAll })
    await server.client.orchestrator.updateModes({ computer_session: 'enforce' })
    server.providers.script(callsTools(['use_computer', useComputer]), callsTools(['sendMessage', { text: "I can't browse" }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'How much are socks?' })
    await untilIdle(server, bot)

    expect(server.computer.calls.filter((call) => call.kind.startsWith('browser.'))).toEqual([])
    expect(JSON.stringify(server.providers.requests[1]!.messages.at(-1))).toContain('No browsing today')
    expect(await server.client.bots.audit({ botId: bot.id })).toMatchObject([
      { surface: 'computer_session', verdict: { decision: 'deny' }, mode: 'enforce' },
    ])
  })

  it('stay out of the chat: only what the bot sends appears', async () => {
    const { server, bot } = await startWithRex()

    await shopForSocks(server, bot)

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.map((message) => [message.author, message.text])).toEqual([
      ['owner', 'How much are socks at the shop?'],
      ['bot', 'Socks are $5'],
    ])
  })

  it('tell the bot when its screen is not running', async () => {
    const { server, bot } = await startWithRex()
    await server.computer.screens.stop({ id: bot.id, name: bot.name })
    server.providers.script(
      callsTools(['use_computer', { goal: 'Look at the shop', reason: 'Needs JavaScript' }]),
      callsTools(['browser_snapshot', {}]),
      says('Needs help: the screen is off.'),
      callsTools(['sendMessage', { text: 'My screen is off' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Look at the shop' })
    await untilIdle(server, bot)

    expect(JSON.stringify(server.providers.requests[2]!.messages.at(-1))).toContain("Rex's screen isn't running")
    const result = JSON.stringify(server.providers.requests[3]!.messages.at(-1))
    expect(result).toContain('Needs help: the screen is off.')
    expect(result).toContain('No final screenshot')
  })

  it('tell the bot to choose its tools in order, the browser after plugins and the shell', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Hi' })
    await untilIdle(server, bot)

    expect(JSON.stringify(server.providers.requests[0]!.messages)).toContain(
      'Choose tools in this order: plugin tools first, then the shell and fetching the web from it (curl, scripts), then the browser through use_computer, then the desktop.',
    )
  })
})
