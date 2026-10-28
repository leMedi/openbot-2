import {
  type Browser,
  type BrowserSnapshot,
  type BrowserTab,
  BrowserUnavailableError,
  type ComputerBot,
  type Screens,
  StaleRefError,
} from '@openbot/core'
import { Cdp, CdpError } from './cdp.ts'

/** Where a screen's browser listens for DevTools, on localhost only. Duplicated from apps/desktopd/src/programs.ts, which imports nothing. */
export const browserDebugPort = (display: number) => 9222 + display

/** How long to wait for a page to load before acting on it anyway. */
const loadTimeoutMs = 15_000
/** How long after an action a navigation it caused may take to start. */
const navigationStartMs = 500

type AxValue = { value?: unknown }
type AxNode = {
  nodeId: string
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  value?: AxValue
  properties?: { name: string; value: AxValue }[]
  childIds?: string[]
  backendDOMNodeId?: number
}

type TargetInfo = { targetId: string; type: string; url: string; title: string }

/** A DevTools session on one tab, and the id of the tab's main frame, whose loads actions wait for. */
type TabSession = { sessionId: string; mainFrame: string }

/** Where a reference points: an element of the tab the snapshot was taken on. */
type RefTarget = { targetId: string; backendNodeId: number }

/** What the client keeps of a bot's browser: its DevTools connection, the tab tools act on, and the latest refs. */
type BotBrowser = {
  port: number
  cdp: Cdp
  active?: string
  sessions: Map<string, Promise<TabSession>>
  refs: Map<string, RefTarget>
  nextRef: number
}

/** The document itself: its URL and title head the snapshot instead. */
const documentRoles = new Set(['RootWebArea', 'WebArea'])
/** Roles that only group others: shown through, unless they have a name. */
const transparentRoles = new Set(['generic', 'none', 'presentation', 'paragraph', 'Section', 'LabelText', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell'])
/** Roles never shown: text is shown as its StaticText. */
const hiddenRoles = new Set(['InlineTextBox', 'LineBreak'])
/** States worth telling the model, shown as `[checked]`, `[expanded=false]`... */
const shownStates = new Set(['checked', 'disabled', 'expanded', 'selected', 'pressed', 'required'])

const axText = (value: AxValue | undefined) => (value?.value === undefined || value.value === null ? '' : String(value.value))

/**
 * Chromium's accessibility tree as the snapshot's lines, `- <role> "<name>" [ref=eN]: <value>`, indented by nesting.
 * `ref` gives each shown element with a DOM node its reference.
 */
export function renderAxTree(nodes: AxNode[], ref: (backendNodeId: number) => string): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const lines: string[] = []
  const visit = (node: AxNode, depth: number, parentName: string) => {
    const role = axText(node.role)
    const name = axText(node.name).trim()
    const shownThrough = node.ignored || documentRoles.has(role) || (transparentRoles.has(role) && !name)
    const children = () => {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id)
        if (child) visit(child, shownThrough ? depth : depth + 1, shownThrough ? parentName : name)
      }
    }
    if (hiddenRoles.has(role)) return
    if (shownThrough) return children()
    const indent = '  '.repeat(depth)
    if (role === 'StaticText') {
      if (name && name !== parentName) lines.push(`${indent}- text: ${name}`)
      return
    }
    const states = (node.properties ?? [])
      .filter((property) => shownStates.has(property.name) && property.value.value !== false && property.value.value !== 'false')
      .map((property) => (property.value.value === true || property.value.value === 'true' ? `[${property.name}]` : `[${property.name}=${axText(property.value)}]`))
    const value = axText(node.value).trim()
    const parts = [`- ${role}`, ...(name ? [JSON.stringify(name)] : []), ...states, ...(node.backendDOMNodeId ? [`[ref=${ref(node.backendDOMNodeId)}]`] : [])]
    lines.push(`${indent}${parts.join(' ')}${value && value !== name ? `: ${value}` : ''}`)
    children()
  }
  const root = nodes[0]
  if (root) visit(root, 0, '')
  return lines.join('\n')
}

/**
 * Each bot's own browser over the Chrome DevTools Protocol: the Chrome on its screen, whose DevTools listen on
 * `127.0.0.1:9222+display`, opened when a tool first needs it and again after the bot closed it. Clicks and typing are
 * real input events, so the owner watching the screen sees them.
 */
export function connectBrowser({ screens }: { screens: Pick<Screens, 'status' | 'openBrowser'> }): Browser {
  const browsers = new Map<string, BotBrowser>()

  const connecting = new Map<string, Promise<BotBrowser>>()

  /** The bot's browser, connected again when its screen restarted (a new browser, so old references go). */
  async function browserOf(bot: ComputerBot): Promise<BotBrowser> {
    const status = await screens.status(bot)
    if (status.state !== 'running' || status.display === null) throw new BrowserUnavailableError(`${bot.name}'s screen isn't running (${status.state})`)
    const port = browserDebugPort(status.display)
    const known = browsers.get(bot.id)
    if (known && known.port === port && !known.cdp.closed) return known
    // One connection per bot, even when two calls find it missing at once.
    let pending = connecting.get(bot.id)
    if (!pending) {
      pending = connect(bot, port)
      connecting.set(bot.id, pending)
      void pending.finally(() => connecting.delete(bot.id)).catch(() => {})
    }
    return pending
  }

  async function connect(bot: ComputerBot, port: number): Promise<BotBrowser> {
    browsers.get(bot.id)?.cdp.close()
    let cdp: Cdp
    try {
      await screens.openBrowser(bot)
      cdp = await Cdp.connect(port)
    } catch (error) {
      throw new BrowserUnavailableError(`${bot.name}'s browser can't be reached: ${(error as Error).message}`)
    }
    const browser: BotBrowser = { port, cdp, sessions: new Map(), refs: new Map(), nextRef: 1 }
    cdp.on('Target.detachedFromTarget', (params) => {
      for (const [targetId, session] of browser.sessions) {
        void session.then(({ sessionId }) => {
          if (sessionId === params.sessionId && browser.sessions.get(targetId) === session) browser.sessions.delete(targetId)
        }, () => {})
      }
    })
    browsers.set(bot.id, browser)
    return browser
  }

  async function pages(browser: BotBrowser): Promise<TargetInfo[]> {
    const { targetInfos } = await browser.cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')
    return targetInfos.filter((target) => target.type === 'page' && !target.url.startsWith('devtools://'))
  }

  /** The tab tools act on: the one last chosen, else the first one, else a new blank one. */
  async function activeTab(browser: BotBrowser): Promise<TargetInfo> {
    const open = await pages(browser)
    const tab = open.find((target) => target.targetId === browser.active) ?? open[0]
    if (tab) {
      browser.active = tab.targetId
      return tab
    }
    const targetId = await blankTab(browser)
    browser.active = targetId
    return { targetId, type: 'page', url: 'about:blank', title: '' }
  }

  async function blankTab(browser: BotBrowser): Promise<string> {
    return (await browser.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId
  }

  async function tabInfo(browser: BotBrowser, targetId: string): Promise<TargetInfo> {
    return (await browser.cdp.send<{ targetInfo: TargetInfo }>('Target.getTargetInfo', { targetId })).targetInfo
  }

  async function mustBeOpen(browser: BotBrowser, tabId: string): Promise<TargetInfo[]> {
    const open = await pages(browser)
    if (!open.some((tab) => tab.targetId === tabId)) throw new Error(`There is no tab ${tabId}`)
    return open
  }

  /** A DevTools session on a tab, with page events on. */
  function session(browser: BotBrowser, targetId: string): Promise<TabSession> {
    let attached = browser.sessions.get(targetId)
    if (!attached) {
      const attaching = (async () => {
        const { sessionId } = await browser.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
        await browser.cdp.send('Page.enable', {}, sessionId)
        const { frameTree } = await browser.cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId)
        return { sessionId, mainFrame: frameTree.frame.id }
      })()
      attaching.catch(() => browser.sessions.get(targetId) === attaching && browser.sessions.delete(targetId))
      browser.sessions.set(targetId, attaching)
      attached = attaching
    }
    return attached
  }

  /** Runs `action`, then waits for a load of the tab's page it started, if any, to finish; iframes don't count. */
  async function settling(browser: BotBrowser, { sessionId, mainFrame }: TabSession, action: () => Promise<unknown>) {
    const isMain = (params: Record<string, unknown>) => params.frameId === mainFrame
    const started = browser.cdp.waitFor('Page.frameStartedLoading', sessionId, navigationStartMs, isMain)
    await action()
    if (await started) await browser.cdp.waitFor('Page.frameStoppedLoading', sessionId, loadTimeoutMs, isMain)
  }

  /** The element `ref` names, if it is on the latest snapshot and that was taken of the active tab. */
  async function element(bot: ComputerBot, ref: string) {
    const browser = await browserOf(bot)
    const target = browser.refs.get(ref)
    const tab = await activeTab(browser)
    if (!target || target.targetId !== tab.targetId) throw new StaleRefError(ref)
    return { browser, tab: await session(browser, tab.targetId), backendNodeId: target.backendNodeId }
  }

  /** CDP's error for an element that left the page, in words the model can act on. */
  function gone(ref: string) {
    return (error: unknown): never => {
      if (error instanceof CdpError && /no node|could not find node|not found/i.test(error.message)) {
        throw new Error(`${ref} is no longer on the page; take a new snapshot`)
      }
      throw error
    }
  }

  async function navigateTab(browser: BotBrowser, targetId: string, url: string) {
    const tab = await session(browser, targetId)
    await settling(browser, tab, async () => {
      const { errorText } = await browser.cdp.send<{ errorText?: string }>('Page.navigate', { url }, tab.sessionId)
      if (errorText) throw new Error(`Couldn't load ${url}: ${errorText}`)
    })
  }

  async function bringToFront(browser: BotBrowser, targetId: string) {
    await browser.cdp.send('Target.activateTarget', { targetId })
  }

  return {
    async snapshot(bot): Promise<BrowserSnapshot> {
      const browser = await browserOf(bot)
      const tab = await activeTab(browser)
      const { sessionId } = await session(browser, tab.targetId)
      const { nodes } = await browser.cdp.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {}, sessionId)
      const refs = new Map<string, RefTarget>()
      const tree = renderAxTree(nodes, (backendNodeId) => {
        const ref = `e${browser.nextRef++}`
        refs.set(ref, { targetId: tab.targetId, backendNodeId })
        return ref
      })
      const targetInfo = await tabInfo(browser, tab.targetId)
      // Only now: a snapshot that failed leaves the previous one's references working.
      browser.refs = refs
      return { url: targetInfo.url, title: targetInfo.title, tree }
    },

    async navigate(bot, url) {
      const browser = await browserOf(bot)
      await navigateTab(browser, (await activeTab(browser)).targetId, url)
    },

    async click(bot, ref) {
      const { browser, tab, backendNodeId } = await element(bot, ref)
      const { cdp } = browser
      const { sessionId } = tab
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, sessionId).catch(gone(ref))
      const { quads } = await cdp.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId }, sessionId).catch(gone(ref))
      const quad = quads[0]
      if (!quad) throw new Error(`${ref} isn't visible, so it can't be clicked`)
      const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4
      const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
      await settling(browser, tab, async () => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
      })
    },

    async type(bot, ref, typed, options) {
      const { browser, tab, backendNodeId } = await element(bot, ref)
      const { cdp } = browser
      const { sessionId } = tab
      await cdp.send('DOM.focus', { backendNodeId }, sessionId).catch(gone(ref))
      // Select what the field holds, so the typing replaces it.
      const { object } = await cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId }, sessionId).catch(gone(ref))
      await cdp.send(
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration:
            'function () { if (typeof this.select === "function") return this.select(); const range = document.createRange(); range.selectNodeContents(this); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range) }',
        },
        sessionId,
      )
      if (typed) await cdp.send('Input.insertText', { text: typed }, sessionId)
      else await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId)
      if (!options?.submit) return
      await settling(browser, tab, async () => {
        const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...enter }, sessionId)
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter }, sessionId)
      })
    },

    async tabs(bot): Promise<BrowserTab[]> {
      const browser = await browserOf(bot)
      const active = await activeTab(browser)
      return (await pages(browser)).map(({ targetId, url, title }) => ({ id: targetId, url, title, active: targetId === active.targetId }))
    },

    async newTab(bot, url): Promise<BrowserTab> {
      const browser = await browserOf(bot)
      const targetId = await blankTab(browser)
      browser.active = targetId
      await bringToFront(browser, targetId)
      if (url) await navigateTab(browser, targetId, url)
      const targetInfo = await tabInfo(browser, targetId)
      return { id: targetId, url: targetInfo.url, title: targetInfo.title, active: true }
    },

    async selectTab(bot, tabId) {
      const browser = await browserOf(bot)
      await mustBeOpen(browser, tabId)
      browser.active = tabId
      await bringToFront(browser, tabId)
    },

    async closeTab(bot, tabId) {
      const browser = await browserOf(bot)
      const open = await mustBeOpen(browser, tabId)
      // Closing the last tab would quit the browser, so a blank one takes its place first.
      if (open.length === 1) await blankTab(browser)
      await browser.cdp.send('Target.closeTarget', { targetId: tabId })
      for (let tries = 0; tries < 50 && (await pages(browser)).some((tab) => tab.targetId === tabId); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      browser.sessions.delete(tabId)
      if (browser.active === tabId) {
        browser.active = undefined
        await bringToFront(browser, (await activeTab(browser)).targetId)
      }
    },

    async screenshot(bot) {
      const browser = await browserOf(bot)
      const { targetId } = await activeTab(browser)
      await bringToFront(browser, targetId)
      const { sessionId } = await session(browser, targetId)
      const { data } = await browser.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId)
      return new Uint8Array(Buffer.from(data, 'base64'))
    },
  }
}
