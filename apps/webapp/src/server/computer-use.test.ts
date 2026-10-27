import { existsSync } from 'node:fs'
import { callsTools, endsSilently, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import type { Orchestrator } from '@openbot/core'
import { fakeEditor, type TestPage } from '@openbot/core/testing'
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
const desktopTools = [
  'desktop_windows',
  'desktop_open',
  'desktop_snapshot',
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'desktop_scroll',
  'desktop_screenshot',
]

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
    ])
    // The final screenshot is of the whole screen.
    expect(server.computer.calls.at(-1)).toEqual({ bot: 'Rex', kind: 'desktop.screenshot' })
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

  it('run on the computer-use model, with only the browser and desktop tools; the bot never has them', async () => {
    const { server, bot } = await startWithRex()

    await shopForSocks(server, bot)

    const [first, ...rest] = server.providers.requests
    const session = rest.slice(0, 3)
    const after = rest.slice(3)
    expect(first!.model).toBe('fake/fake-mini')
    expect(first!.tools).toContain('use_computer')
    for (const request of [first!, ...after]) {
      expect(request.model).toBe('fake/fake-mini')
      expect(request.tools.filter((tool) => tool.startsWith('browser_') || tool.startsWith('desktop_'))).toEqual([])
    }
    for (const request of session) {
      expect(request.model).toBe('fake/fake-model')
      expect(request.tools.sort()).toEqual([...browserTools, ...desktopTools, 'needs_help'].sort())
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

  it('operate a desktop app by reference, each action reporting its effect', async () => {
    const { server, bot } = await startWithRex()
    const goal = { goal: 'Write "Milk, eggs" in a new text document', reason: 'Testing the desktop' }
    server.providers.script(
      callsTools(['use_computer', goal]),
      callsTools(['desktop_open', { app: fakeEditor }]),
      callsTools(['desktop_snapshot', { windowId: 1 }]),
      // The editor's snapshot: New is d1, Save d2, the document's text d3.
      callsTools(['desktop_type', { ref: 'd3', text: 'Milk, eggs' }]),
      callsTools(['desktop_key', { windowId: 1, keys: 'Return' }]),
      callsTools(['desktop_snapshot', { windowId: 1 }]),
      says('The document now reads "Milk, eggs".'),
      callsTools(['sendMessage', { text: 'Done' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Write my shopping list' })
    await untilIdle(server, bot)

    const results = server.providers.requests.slice(2, 7).map((request) => JSON.stringify(request.messages.at(-1)))
    expect(results[0]).toContain('Opened editor:\\n- 1: Editor — Untitled 1 - Editor')
    expect(results[1]).toContain('- [ref=d3] text \\"\\"')
    expect(results[2]).toContain("Effect: confirmed. Typed 10 character(s); it reads back 'Milk, eggs'.")
    expect(results[3]).toContain('Effect: unverifiable. Pressed Return')
    expect(results[4]).toContain('text \\"Milk, eggs\\\\n\\"')
    expect(server.computer.calls.filter((call) => call.kind.startsWith('desktop.') && call.kind !== 'desktop.screenshot')).toEqual([
      { bot: 'Rex', kind: 'desktop.open', app: fakeEditor },
      { bot: 'Rex', kind: 'desktop.snapshot', window: 1 },
      { bot: 'Rex', kind: 'desktop.type', into: { ref: 'd3' }, text: 'Milk, eggs' },
      { bot: 'Rex', kind: 'desktop.press', window: 1, keys: 'Return' },
      { bot: 'Rex', kind: 'desktop.snapshot', window: 1 },
    ])
    // Reviewed as one session, and summed up when it ended; desktop actions open no pages.
    expect((await server.client.bots.audit({ botId: bot.id })).map(({ kind, tool }) => [kind, tool])).toEqual([
      ['action', 'use_computer'],
      ['session_summary', 'use_computer'],
    ])
  })

  it('report a stale desktop reference as a refused action, not an error', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      callsTools(['use_computer', { goal: 'Start a new document', reason: 'Testing the desktop' }]),
      callsTools(['desktop_open', { app: fakeEditor }]),
      callsTools(['desktop_snapshot', { windowId: 1 }]),
      callsTools(['desktop_snapshot', { windowId: 1 }]),
      // d1 was New on the first snapshot; the second gave it d4.
      callsTools(['desktop_click', { ref: 'd1' }]),
      callsTools(['desktop_click', { ref: 'd4' }]),
      says('A new document is open.'),
      callsTools(['sendMessage', { text: 'Done' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'New document please' })
    await untilIdle(server, bot)

    const [stale, fresh] = [server.providers.requests[5]!, server.providers.requests[6]!].map((request) => request.messages.at(-1)!)
    expect(stale).toMatchObject({ role: 'toolResult', toolName: 'desktop_click', isError: false })
    expect(JSON.stringify(stale)).toContain("Effect: refused. d1 isn't on the latest snapshot")
    expect(JSON.stringify(fresh)).toContain('Effect: confirmed. Clicked push button \\"New\\"')
  })

  it('are written to the audit log with their reason', async () => {
    const { server, bot } = await startWithRex()

    await shopForSocks(server, bot)

    const actions = (await server.client.bots.audit({ botId: bot.id })).filter((entry) => entry.kind === 'action')
    expect(actions.map(({ surface, tool, input }) => ({ surface, tool, input }))).toEqual([
      { surface: 'computer_session', tool: 'use_computer', input: useComputer },
    ])
  })

  it('write each page their browser opens to the audit log, with the tool that opened it', async () => {
    const { server, bot } = await startWithRex()

    await shopForSocks(server, bot)

    const navigations = (await server.client.bots.audit({ botId: bot.id })).filter((entry) => entry.kind === 'navigation')
    expect(navigations.map(({ surface, tool, input, verdict }) => ({ surface, tool, input, verdict }))).toEqual([
      { surface: 'computer_session', tool: 'use_computer', input: { url: shop, title: 'Shop' }, verdict: null },
      { surface: 'computer_session', tool: 'browser_click', input: { url: socks, title: 'Socks' }, verdict: null },
    ])
  })

  it('write a summary to the audit log when they end: actions by tool, screenshots and duration', async () => {
    const { server, bot } = await startWithRex()

    await shopForSocks(server, bot)

    const entries = await server.client.bots.audit({ botId: bot.id })
    expect(entries.at(-1)).toMatchObject({
      kind: 'session_summary',
      surface: 'computer_session',
      tool: 'use_computer',
      // The session's own calls, and the final screenshot.
      input: { outcome: 'done', actions: { browser_snapshot: 1, browser_click: 1 }, screenshots: 1, durationMs: expect.any(Number) },
      verdict: null,
    })
    expect(entries.filter((entry) => entry.kind === 'session_summary')).toHaveLength(1)
  })

  it('write a summary when they stop to ask the owner for help', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      callsTools(['use_computer', { goal: 'Sign in to the shop', reason: 'Testing' }]),
      callsTools(['browser_screenshot', {}]),
      callsTools(['needs_help', { instruction: 'Sign in to shop.test' }]),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Sign in please' })
    await untilIdle(server, bot)

    const summary = (await server.client.bots.audit({ botId: bot.id })).find((entry) => entry.kind === 'session_summary')
    expect(summary?.input).toMatchObject({ outcome: 'needs_help', actions: { browser_screenshot: 1, needs_help: 1 }, screenshots: 1 })
  })

  it('log the navigations they make with browser_navigate, with secrets in their URLs redacted', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      callsTools(['use_computer', { goal: 'Look at the shop', reason: 'Testing' }]),
      callsTools(['browser_navigate', { url: `${shop}?token=abc123secret` }]),
      callsTools(['browser_navigate', { url: 'https://ana:hunter2@shop.test/callback?code=oauth-code-123&sig=signed-456&page=2' }]),
      callsTools(['browser_snapshot', {}]),
      says('Seen it.'),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Look at the shop' })
    await untilIdle(server, bot)

    const navigations = (await server.client.bots.audit({ botId: bot.id })).filter((entry) => entry.kind === 'navigation')
    expect(navigations.map(({ tool, input }) => ({ tool, input }))).toEqual([
      { tool: 'browser_navigate', input: { url: `${shop}?token=[redacted]`, title: expect.any(String) } },
      {
        tool: 'browser_navigate',
        input: { url: 'https://ana:[redacted]@shop.test/callback?code=[redacted]&sig=[redacted]&page=2', title: expect.any(String) },
      },
    ])
  })

  it('are written to the audit log, unreviewed, when their surface is off', async () => {
    const denyAll: Orchestrator = { review: async () => ({ decision: 'deny', reason: 'No browsing today' }) }
    const { server, bot } = await startWithRex({ orchestrator: denyAll })
    await server.client.orchestrator.updateModes({ computer_session: 'off' })

    await shopForSocks(server, bot)

    const entries = await server.client.bots.audit({ botId: bot.id })
    expect(entries[0]).toMatchObject({ kind: 'action', surface: 'computer_session', tool: 'use_computer', input: useComputer, verdict: null, mode: 'off' })
    // Its pages and summary are logged as when it is reviewed.
    expect(entries.map(({ kind, verdict }) => [kind, verdict])).toEqual([
      ['action', null],
      ['navigation', null],
      ['navigation', null],
      ['session_summary', null],
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
      says('The screen is off.'),
      callsTools(['sendMessage', { text: 'My screen is off' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Look at the shop' })
    await untilIdle(server, bot)

    expect(JSON.stringify(server.providers.requests[2]!.messages.at(-1))).toContain("Rex's screen isn't running")
    const result = JSON.stringify(server.providers.requests[3]!.messages.at(-1))
    expect(result).toContain('The screen is off.')
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
