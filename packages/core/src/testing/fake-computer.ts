import { createServer, type Server } from 'node:net'
import {
  type Browser,
  type BrowserSnapshot,
  type BrowserTab,
  BrowserUnavailableError,
  type Computer,
  type ComputerBot,
  type ExecResult,
  type ScreenStatus,
  StaleRefError,
  stoppedScreen,
} from '../ports/computer.ts'
import type { TestPage } from './pages.ts'

export type ComputerCall =
  | { bot: string; kind: 'screens.start'; display: number }
  | { bot: string; kind: 'screens.stop' | 'browser.snapshot' | 'browser.screenshot' }
  | { bot: string; kind: 'shell.exec'; command: string }
  | { bot: string; kind: 'browser.navigate'; url: string }
  | { bot: string; kind: 'browser.click'; ref: string }
  | { bot: string; kind: 'browser.type'; ref: string; text: string; submit?: true }
  | { bot: string; kind: 'browser.newTab'; url?: string }
  | { bot: string; kind: 'browser.selectTab' | 'browser.closeTab'; tabId: string }

export type FakeComputerScript = {
  /** Result for a command; `undefined` falls back to an empty success. */
  shell?: (command: string, bot: ComputerBot) => ExecResult | undefined
  /** Pages the browser shows, by URL; any other URL is an empty page. */
  pages?: Record<string, TestPage>
}

export type FakeComputer = Computer & {
  /** Every side-effecting call, in order, keyed by bot name. Status reads are not recorded. */
  readonly calls: ComputerCall[]
  /** Pages the browser shows, by URL; add more any time. */
  readonly pages: Map<string, TestPage>
  /** Kills the bot's screen; it comes back at once, as the daemon restarts it. */
  crash(bot: ComputerBot): Promise<void>
  /** Closes every screen's stream. */
  close(): Promise<void>
}

type FakeScreen = { display: number; startedAt: number; stream: Server; streamPort: number }

type FakeTab = { id: string; url: string; values: Map<number, string> }

/** A bot's browser: its tabs, and the references of its latest snapshot to elements of the page it was taken on. */
type FakeBrowserState = { tabs: FakeTab[]; active: string; refs: Map<string, { tabId: string; url: string; index: number }> }

/** A 1×1 PNG. */
export const fakeScreenshot = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'),
)

/** A stream that greets like a VNC server, on a free local port. */
async function openStream(): Promise<{ stream: Server; streamPort: number }> {
  const stream = createServer((socket) => socket.end('RFB 003.008\n'))
  await new Promise<void>((resolve) => stream.listen(0, '127.0.0.1', resolve))
  stream.unref()
  return { stream, streamPort: (stream.address() as { port: number }).port }
}

function closeStream(stream: Server): Promise<void> {
  return new Promise((resolve) => stream.close(() => resolve()))
}

/** An in-memory computer that records calls instead of running anything. */
export function createFakeComputer(script: FakeComputerScript = {}): FakeComputer {
  const calls: ComputerCall[] = []
  const screens = new Map<string, FakeScreen>()
  const pages = new Map(Object.entries(script.pages ?? {}))
  const browsers = new Map<string, FakeBrowserState>()
  // Strictly increasing, so a restarted screen's start time always differs.
  let clock = Date.now()
  const now = () => (clock = Math.max(clock + 1, Date.now()))

  const status = (botId: string): ScreenStatus => {
    const screen = screens.get(botId)
    if (!screen) return stoppedScreen
    return { state: 'running', display: screen.display, startedAt: screen.startedAt, streamPort: screen.streamPort }
  }

  async function stop(botId: string) {
    const screen = screens.get(botId)
    screens.delete(botId)
    // Its browser goes with it, as its profile does.
    browsers.delete(botId)
    if (screen) await closeStream(screen.stream)
  }

  let nextRef = 1
  let nextTab = 1
  const pageAt = (url: string): TestPage => pages.get(url) ?? { title: '', elements: [] }

  /** The bot's browser, which only runs while its screen does. */
  function browserOf(bot: ComputerBot): FakeBrowserState {
    if (!screens.has(bot.id)) throw new BrowserUnavailableError(`${bot.name}'s screen isn't running`)
    let state = browsers.get(bot.id)
    if (!state) {
      const tab = { id: `tab-${nextTab++}`, url: 'about:blank', values: new Map() }
      state = { tabs: [tab], active: tab.id, refs: new Map() }
      browsers.set(bot.id, state)
    }
    return state
  }

  const activeTab = (state: FakeBrowserState) => state.tabs.find((tab) => tab.id === state.active)!

  function load(tab: FakeTab, url: string) {
    tab.url = url
    tab.values = new Map()
  }

  /** The element `ref` names on the active tab's page, if the latest snapshot was taken there and it is still shown. */
  function element(state: FakeBrowserState, ref: string) {
    const target = state.refs.get(ref)
    const tab = activeTab(state)
    if (!target || target.tabId !== tab.id || target.url !== tab.url) throw new StaleRefError(ref)
    return { tab, index: target.index, element: pageAt(tab.url).elements[target.index]! }
  }

  const tabInfo = (tab: FakeTab): BrowserTab => ({ id: tab.id, url: tab.url, title: pageAt(tab.url).title, active: false })

  const browser: Browser = {
    async snapshot(bot): Promise<BrowserSnapshot> {
      calls.push({ bot: bot.name, kind: 'browser.snapshot' })
      const state = browserOf(bot)
      const tab = activeTab(state)
      const page = pageAt(tab.url)
      state.refs = new Map()
      const lines = page.elements.map((element, index) => {
        if (element.role === 'text') return `- text: ${element.name}`
        const ref = `e${nextRef++}`
        state.refs.set(ref, { tabId: tab.id, url: tab.url, index })
        const value = tab.values.get(index)
        return `- ${element.role} ${JSON.stringify(element.name)} [ref=${ref}]${value ? `: ${value}` : ''}`
      })
      return { url: tab.url, title: page.title, tree: lines.join('\n') }
    },
    async navigate(bot, url) {
      calls.push({ bot: bot.name, kind: 'browser.navigate', url })
      load(activeTab(browserOf(bot)), url)
    },
    async click(bot, ref) {
      calls.push({ bot: bot.name, kind: 'browser.click', ref })
      const { tab, element: clicked } = element(browserOf(bot), ref)
      if ((clicked.role === 'link' || clicked.role === 'button') && clicked.href) load(tab, clicked.href)
    },
    async type(bot, ref, text, options) {
      calls.push({ bot: bot.name, kind: 'browser.type', ref, text, ...(options?.submit && { submit: true as const }) })
      const { tab, index, element: field } = element(browserOf(bot), ref)
      if (field.role !== 'textbox') throw new Error(`${ref} is a ${field.role}, not a field you can type into`)
      tab.values.set(index, text)
    },
    async tabs(bot) {
      const state = browserOf(bot)
      return state.tabs.map((tab) => ({ ...tabInfo(tab), active: tab.id === state.active }))
    },
    async newTab(bot, url) {
      calls.push({ bot: bot.name, kind: 'browser.newTab', ...(url && { url }) })
      const state = browserOf(bot)
      const tab = { id: `tab-${nextTab++}`, url: url ?? 'about:blank', values: new Map() }
      state.tabs.push(tab)
      state.active = tab.id
      return { ...tabInfo(tab), active: true }
    },
    async selectTab(bot, tabId) {
      calls.push({ bot: bot.name, kind: 'browser.selectTab', tabId })
      const state = browserOf(bot)
      if (!state.tabs.some((tab) => tab.id === tabId)) throw new Error(`There is no tab ${tabId}`)
      state.active = tabId
    },
    async closeTab(bot, tabId) {
      calls.push({ bot: bot.name, kind: 'browser.closeTab', tabId })
      const state = browserOf(bot)
      if (!state.tabs.some((tab) => tab.id === tabId)) throw new Error(`There is no tab ${tabId}`)
      state.tabs = state.tabs.filter((tab) => tab.id !== tabId)
      // Like a browser closing its last window's last tab, a fresh blank one takes its place.
      if (!state.tabs.length) state.tabs.push({ id: `tab-${nextTab++}`, url: 'about:blank', values: new Map() })
      if (state.active === tabId) state.active = state.tabs.at(-1)!.id
    },
    async screenshot(bot) {
      calls.push({ bot: bot.name, kind: 'browser.screenshot' })
      browserOf(bot)
      return fakeScreenshot
    },
  }

  return {
    calls,
    pages,
    screens: {
      async start(bot) {
        calls.push({ bot: bot.name, kind: 'screens.start', display: bot.display })
        const screen = screens.get(bot.id)
        if (screen?.display === bot.display) return status(bot.id)
        await stop(bot.id)
        // Like the daemon: a display belongs to one screen, so whoever held it gives it up.
        for (const [botId, other] of screens) if (other.display === bot.display) await stop(botId)
        screens.set(bot.id, { display: bot.display, startedAt: now(), ...(await openStream()) })
        return status(bot.id)
      },
      async stop(bot) {
        calls.push({ bot: bot.name, kind: 'screens.stop' })
        await stop(bot.id)
      },
      async status(bot) {
        return status(bot.id)
      },
      async list() {
        return [...screens.keys()].map((botId) => ({ botId, ...status(botId) }))
      },
    },
    async crash(bot) {
      const screen = screens.get(bot.id)
      if (!screen) return
      await closeStream(screen.stream)
      screens.set(bot.id, { display: screen.display, startedAt: now(), ...(await openStream()) })
    },
    async close() {
      await Promise.all([...screens.keys()].map(stop))
    },
    shell: {
      async exec(bot, command) {
        calls.push({ bot: bot.name, kind: 'shell.exec', command })
        return script.shell?.(command, bot) ?? { stdout: '', stderr: '', exitCode: 0 }
      },
    },
    browser,
  }
}
