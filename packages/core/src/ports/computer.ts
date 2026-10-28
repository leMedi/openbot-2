/** Which bot's screen, folder and browser a call targets. */
export type ComputerBot = { id: string; name: string }

/** A bot with the X display its screen runs on; stable for the bot's lifetime. */
export type ScreenBot = ComputerBot & { display: number }

/** Every screen's size, as Grok's. */
export const screenSize = { width: 1280, height: 800 } as const

/**
 * A screen's state: `starting` until its display, window manager, browser and stream are up; `crashed` while it is
 * being restarted after one of them died; `stopped` when there is no screen for the bot.
 */
export type ScreenState = 'stopped' | 'starting' | 'running' | 'crashed'

export type ScreenStatus = {
  state: ScreenState
  display: number | null
  /** When the screen's display last (re)started, in ms since the epoch; unchanged while it keeps running. */
  startedAt: number | null
  /**
   * The local TCP port serving the screen's live stream (the VNC protocol), reachable only from inside the computer;
   * the server proxies it to the owner on tickets.
   */
  streamPort: number | null
}

/** A screen the computer is keeping running. */
export type ScreenListing = ScreenStatus & { botId: string }

export const stoppedScreen: ScreenStatus = { state: 'stopped', display: null, startedAt: null, streamPort: null }

/**
 * An accessibility snapshot of the bot's current page: one line per element, indented by nesting, e.g.
 * `- link "Pricing" [ref=e12]` or `- textbox "Email" [ref=e14]: ada@example.com`. Only the references of a tab's latest
 * snapshot are accepted, so a model can't act on a page it hasn't looked at since it changed.
 */
export type BrowserSnapshot = { url: string; title: string; tree: string }

/** A tab of a bot's browser; the browser tools act on the `active` one. */
export type BrowserTab = { id: string; url: string; title: string; active: boolean }

/** An element reference that isn't on the latest snapshot: made up, from an older snapshot, or from another tab. */
export class StaleRefError extends Error {
  constructor(ref: string) {
    super(`${ref} isn't on the latest snapshot of this tab; take a new snapshot and use its references`)
  }
}

/** The bot's browser can't be reached, e.g. its screen isn't running. */
export class BrowserUnavailableError extends Error {}

/**
 * Each bot's own browser on its screen, driven like a person would: look (snapshot), then act on what was seen by
 * reference, then look again.
 */
export interface Browser {
  /** Snapshots the active tab; references from any earlier snapshot stop working. */
  snapshot(bot: ComputerBot): Promise<BrowserSnapshot>
  /** Loads `url` in the active tab and waits for it. */
  navigate(bot: ComputerBot, url: string): Promise<void>
  click(bot: ComputerBot, ref: string): Promise<void>
  /** Replaces the text of a field; `submit` then presses Enter. */
  type(bot: ComputerBot, ref: string, text: string, options?: { submit?: boolean }): Promise<void>
  tabs(bot: ComputerBot): Promise<BrowserTab[]>
  /** Opens a tab, at `url` or blank, and makes it the active one. */
  newTab(bot: ComputerBot, url?: string): Promise<BrowserTab>
  selectTab(bot: ComputerBot, tabId: string): Promise<void>
  /** Closes a tab; when it was the active one, another becomes active. */
  closeTab(bot: ComputerBot, tabId: string): Promise<void>
  /** The active tab as the owner would see it, as PNG bytes. */
  screenshot(bot: ComputerBot): Promise<Uint8Array>
}

/** A top-level window on a bot's screen, by the id its desktop gives it; positions are in screen pixels. */
export type DesktopWindow = { id: number; app: string; title: string; x: number; y: number; width: number; height: number }

/**
 * A window's accessibility tree: one element per line, indented by nesting, each element the desktop can act on with a
 * reference, e.g. `- [ref=d12] button "Save"` or `- [ref=d14] text "Hello"`. As with the browser, only the
 * references of the latest snapshot (of any window) are accepted.
 */
export type DesktopSnapshot = { window: DesktopWindow; tree: string }

/**
 * What a desktop action did, as far as the desktop could tell:
 * - `confirmed`: read back, e.g. the field now holds the typed text;
 * - `unverifiable`: delivered, but its effect couldn't be seen; look before doing it again;
 * - `suspected_noop`: delivered, but nothing seems to have changed;
 * - `partial`: only part of it landed;
 * - `refused`: nothing was delivered, e.g. a stale reference or a point outside the window.
 */
export const desktopEffects = ['confirmed', 'unverifiable', 'suspected_noop', 'partial', 'refused'] as const
export type DesktopEffect = (typeof desktopEffects)[number]

/** A desktop action's effect, and what happened in words, with a hint of what to do next when it isn't confirmed. */
export type DesktopActionResult = { effect: DesktopEffect; summary: string }

/** An element of the latest snapshot, by reference. */
export type DesktopElement = { ref: string }
/** A whole window, by id: keys and text go to what has focus in it. */
export type DesktopWindowTarget = { window: number }
/** A point of a window, in pixels of its latest screenshot. */
export type DesktopPoint = { window: number; x: number; y: number }

/** The bot's desktop can't be reached, e.g. its screen isn't running. */
export class DesktopUnavailableError extends Error {}

/**
 * Each bot's desktop apps on its screen, driven through their accessibility trees: look (snapshot), act on what was seen
 * by reference (or by a point of a screenshot when an app shows no tree), then look again. Every action reports its
 * effect, so the caller verifies instead of assuming.
 */
export interface Desktop {
  /** The screen's top-level windows, the browser's included. */
  windows(bot: ComputerBot): Promise<DesktopWindow[]>
  /** Opens an app by name or command, e.g. `mousepad`, and returns its windows once one shows. */
  open(bot: ComputerBot, app: string): Promise<DesktopWindow[]>
  /** Snapshots a window's accessibility tree; references from any earlier snapshot stop working. */
  snapshot(bot: ComputerBot, windowId: number): Promise<DesktopSnapshot>
  click(bot: ComputerBot, at: DesktopElement | DesktopPoint, options?: { button?: 'left' | 'right'; count?: 1 | 2 }): Promise<DesktopActionResult>
  /** Types text into an element, or into whatever has focus in a window. */
  type(bot: ComputerBot, into: DesktopElement | DesktopWindowTarget, text: string): Promise<DesktopActionResult>
  /** Presses a key or a combination in a window, e.g. `Return` or `ctrl+s`. */
  press(bot: ComputerBot, windowId: number, keys: string): Promise<DesktopActionResult>
  scroll(
    bot: ComputerBot,
    at: DesktopElement | DesktopWindowTarget,
    direction: 'up' | 'down' | 'left' | 'right',
    amount?: number,
  ): Promise<DesktopActionResult>
  /** A window, or the whole screen without one, as PNG bytes. Points are measured on a window's latest screenshot. */
  screenshot(bot: ComputerBot, windowId?: number): Promise<Uint8Array>
}

/** Every bot's always-on screen: a virtual display, a window manager and the bot's own browser. */
export interface Screens {
  /** Starts the bot's screen at its display, or keeps it if it is already running there. Doesn't wait for it to be up. */
  start(bot: ScreenBot): Promise<ScreenStatus>
  /** Stops the bot's screen and deletes its browser profile. */
  stop(bot: ComputerBot): Promise<void>
  status(bot: ComputerBot): Promise<ScreenStatus>
  /**
   * Opens the bot's browser on its running screen unless it is open (screens start without one), resolving once it can
   * be driven; throws when the screen isn't running.
   */
  openBrowser(bot: ComputerBot): Promise<void>
  /** Every screen being kept running. */
  list(): Promise<ScreenListing[]>
  /**
   * Calls `listener` each time what keeps the screens (the screen daemon) is found to have restarted since it was last
   * reached, so the caller can bring every bot's screen back; returns a function that stops listening.
   */
  onRestart(listener: () => void): () => void
}

/**
 * The machine all bots share: their screens, browsers and desktops. The real one is the screen daemon's client, the
 * browser over CDP and the desktop through each screen's cua-driver (`@openbot/computer`); Seam 1 tests use the
 * in-memory fake from `@openbot/core/testing`. Both pass the contract suite there. Bots' shell and files are not here:
 * they run only through `BotComputer` (`@openbot/agent`).
 */
export interface Computer {
  screens: Screens
  browser: Browser
  desktop: Desktop
}
