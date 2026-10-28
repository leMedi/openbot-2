import { createServer, type Server } from 'node:net'
import {
  type Browser,
  type BrowserSnapshot,
  type BrowserTab,
  BrowserUnavailableError,
  type Computer,
  type ComputerBot,
  type Desktop,
  type DesktopActionResult,
  type DesktopElement,
  type DesktopPoint,
  DesktopUnavailableError,
  type DesktopWindow,
  type DesktopWindowTarget,
  type ScreenStatus,
  StaleRefError,
  stoppedScreen,
} from '../ports/computer.ts'
import type { TestPage } from './pages.ts'

export type ComputerCall =
  | { bot: string; kind: 'screens.start'; display: number }
  | { bot: string; kind: 'screens.stop' | 'browser.snapshot' | 'browser.screenshot' }
  | { bot: string; kind: 'browser.navigate'; url: string }
  | { bot: string; kind: 'browser.click'; ref: string }
  | { bot: string; kind: 'browser.type'; ref: string; text: string; submit?: true }
  | { bot: string; kind: 'browser.newTab'; url?: string }
  | { bot: string; kind: 'browser.selectTab' | 'browser.closeTab'; tabId: string }
  | { bot: string; kind: 'desktop.open'; app: string }
  | { bot: string; kind: 'desktop.snapshot' | 'desktop.screenshot'; window?: number }
  | { bot: string; kind: 'desktop.click'; at: DesktopElement | DesktopPoint; button?: 'right'; count?: 2 }
  | { bot: string; kind: 'desktop.type'; into: DesktopElement | DesktopWindowTarget; text: string }
  | { bot: string; kind: 'desktop.press'; window: number; keys: string }
  | { bot: string; kind: 'desktop.scroll'; at: DesktopElement | DesktopWindowTarget; direction: string; amount?: number }

export type FakeComputerScript = {
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
  /**
   * Restarts the computer as the screen daemon restarting without its saved screens would: every screen is lost, then
   * listeners are told.
   */
  restart(): Promise<void>
  /** Closes every screen's stream. */
  close(): Promise<void>
}

type FakeScreen = { display: number; startedAt: number; stream: Server; streamPort: number }

type FakeTab = { id: string; url: string; values: Map<number, string> }

/** A bot's browser: its tabs, and the references of its latest snapshot to elements of the page it was taken on. */
type FakeBrowserState = { tabs: FakeTab[]; active: string; refs: Map<string, { tabId: string; url: string; index: number }> }

/** What opens the fake's text editor, the one desktop app it has: a `text` element and a "New" button that adds a tab. */
export const fakeEditor = 'editor'

/** An editor window: its documents (one per tab, the last one shown) and whether all of the shown one is selected. */
type FakeEditorWindow = DesktopWindow & { documents: string[]; allSelected: boolean }

/** A bot's desktop: its open windows, and the references of its latest snapshot to elements of one of them. */
type FakeDesktopState = { windows: FakeEditorWindow[]; refs: Map<string, { window: number; element: 'new' | 'save' | 'text' }> }

const stale = (ref: string): DesktopActionResult => ({
  effect: 'refused',
  summary: `${ref} isn't on the latest snapshot; take a new snapshot and use its references`,
})

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
  const desktops = new Map<string, FakeDesktopState>()
  const restartListeners = new Set<() => void>()
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
    // Its browser goes with it, as its profile does, and so do its apps.
    browsers.delete(botId)
    desktops.delete(botId)
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

  let nextWindow = 1
  let nextDesktopRef = 1

  /** The bot's desktop, which only runs while its screen does. */
  function desktopOf(bot: ComputerBot): FakeDesktopState {
    if (!screens.has(bot.id)) throw new DesktopUnavailableError(`${bot.name}'s screen isn't running`)
    let state = desktops.get(bot.id)
    if (!state) desktops.set(bot.id, (state = { windows: [], refs: new Map() }))
    return state
  }

  function windowOf(state: FakeDesktopState, id: number): FakeEditorWindow {
    const window = state.windows.find((each) => each.id === id)
    if (!window) throw new Error(`There's no window ${id} on the screen`)
    return window
  }

  const listed = ({ documents: _, allSelected: __, ...window }: FakeEditorWindow): DesktopWindow => window

  /** Types into the shown document: replacing it when all of it is selected, else adding to it. */
  function typeInto(window: FakeEditorWindow, text: string) {
    const shown = window.documents.length - 1
    window.documents[shown] = window.allSelected ? text : window.documents[shown] + text
    window.allSelected = false
  }

  const desktop: Desktop = {
    async windows(bot) {
      return desktopOf(bot).windows.map(listed)
    },
    async open(bot, app) {
      calls.push({ bot: bot.name, kind: 'desktop.open', app })
      const state = desktopOf(bot)
      if (app !== fakeEditor) throw new Error(`There's no app called ${app}`)
      const id = nextWindow++
      const window = { id, app: 'Editor', title: `Untitled ${id} - Editor`, x: 320, y: 166, width: 640, height: 480, documents: [''], allSelected: false }
      state.windows.push(window)
      return [listed(window)]
    },
    async snapshot(bot, windowId) {
      calls.push({ bot: bot.name, kind: 'desktop.snapshot', window: windowId })
      const state = desktopOf(bot)
      const window = windowOf(state, windowId)
      state.refs = new Map()
      const ref = (element: 'new' | 'save' | 'text') => {
        const name = `d${nextDesktopRef++}`
        state.refs.set(name, { window: windowId, element })
        return `[ref=${name}]`
      }
      const lines = [
        `- frame "${window.title}"`,
        `  - ${ref('new')} button "New"`,
        `  - ${ref('save')} button "Save"`,
        ...window.documents.flatMap((document, index) =>
          index === window.documents.length - 1 ? [`  - page tab ""`, `    - ${ref('text')} text ${JSON.stringify(document)}`] : [`  - page tab ""`],
        ),
      ]
      return { window: listed(window), tree: lines.join('\n') }
    },
    async click(bot, at, options) {
      calls.push({ bot: bot.name, kind: 'desktop.click', at, ...(options?.button === 'right' && { button: 'right' as const }), ...(options?.count === 2 && { count: 2 as const }) })
      const state = desktopOf(bot)
      if ('ref' in at) {
        const target = state.refs.get(at.ref)
        if (!target) return stale(at.ref)
        const window = windowOf(state, target.window)
        if (target.element === 'new') {
          window.documents.push('')
          window.allSelected = false
          return { effect: 'confirmed', summary: 'Clicked button "New"; a new tab opened.' }
        }
        return { effect: 'unverifiable', summary: `Clicked ${target.element}; look to see what changed.` }
      }
      windowOf(state, at.window)
      return { effect: 'unverifiable', summary: `Clicked at (${at.x}, ${at.y}); not verified, look to see what changed.` }
    },
    async type(bot, into, text) {
      calls.push({ bot: bot.name, kind: 'desktop.type', into, text })
      const state = desktopOf(bot)
      if ('ref' in into) {
        const target = state.refs.get(into.ref)
        if (!target) return stale(into.ref)
        if (target.element !== 'text') return { effect: 'refused', summary: `${into.ref} is a button, not a field you can type into` }
        const window = windowOf(state, target.window)
        typeInto(window, text)
        return { effect: 'confirmed', summary: `Typed ${text.length} character(s); it reads back '${window.documents.at(-1)}'.` }
      }
      typeInto(windowOf(state, into.window), text)
      return { effect: 'unverifiable', summary: `Typed ${text.length} character(s) as key events; not verified, look before typing again.` }
    },
    async press(bot, windowId, keys) {
      calls.push({ bot: bot.name, kind: 'desktop.press', window: windowId, keys })
      const window = windowOf(desktopOf(bot), windowId)
      if (keys === 'ctrl+a') window.allSelected = true
      else if (keys === 'Return') typeInto(window, '\n')
      return { effect: 'unverifiable', summary: `Pressed ${keys}; not verified, look to see what changed.` }
    },
    async scroll(bot, at, direction, amount) {
      calls.push({ bot: bot.name, kind: 'desktop.scroll', at, direction, ...(amount !== undefined && { amount }) })
      const state = desktopOf(bot)
      if ('ref' in at && !state.refs.has(at.ref)) return stale(at.ref)
      if ('window' in at) windowOf(state, at.window)
      return { effect: 'unverifiable', summary: `Scrolled ${direction}; not verified, look to see what moved.` }
    },
    async screenshot(bot, windowId) {
      calls.push({ bot: bot.name, kind: 'desktop.screenshot', ...(windowId !== undefined && { window: windowId }) })
      const state = desktopOf(bot)
      if (windowId !== undefined) windowOf(state, windowId)
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
      onRestart(listener) {
        // Its own entry, so one listener added twice is told twice and removed once.
        const entry = () => listener()
        restartListeners.add(entry)
        return () => void restartListeners.delete(entry)
      },
    },
    async crash(bot) {
      const screen = screens.get(bot.id)
      if (!screen) return
      await closeStream(screen.stream)
      // Its apps die with its display.
      desktops.delete(bot.id)
      screens.set(bot.id, { display: screen.display, startedAt: now(), ...(await openStream()) })
    },
    async restart() {
      await Promise.all([...screens.keys()].map(stop))
      for (const listener of [...restartListeners]) listener()
    },
    async close() {
      await Promise.all([...screens.keys()].map(stop))
    },
    browser,
    desktop,
  }
}
