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

export type ExecResult = { stdout: string; stderr: string; exitCode: number }

/** An accessibility snapshot of the bot's current page, with `[ref=eN]` element references. */
export type BrowserSnapshot = { url: string; title: string; tree: string }

/** Every bot's always-on screen: a virtual display, a window manager and the bot's own browser. */
export interface Screens {
  /** Starts the bot's screen at its display, or keeps it if it is already running there. Doesn't wait for it to be up. */
  start(bot: ScreenBot): Promise<ScreenStatus>
  /** Stops the bot's screen and deletes its browser profile. */
  stop(bot: ComputerBot): Promise<void>
  status(bot: ComputerBot): Promise<ScreenStatus>
  /** Every screen being kept running. */
  list(): Promise<ScreenListing[]>
}

/**
 * The machine all bots share. The real one is the screen daemon's client (`@openbot/computer`) plus the bots' shell
 * from `@openbot/agent`; Seam 1 tests use the in-memory fake from `@openbot/core/testing`. Both pass the contract
 * suite there.
 */
export interface Computer {
  screens: Screens
  /** Runs a command as the `openbot` user, in the bot's folder. */
  shell: {
    exec(bot: ComputerBot, command: string): Promise<ExecResult>
  }
  browser: {
    snapshot(bot: ComputerBot): Promise<BrowserSnapshot>
    navigate(bot: ComputerBot, url: string): Promise<void>
    click(bot: ComputerBot, ref: string): Promise<void>
    type(bot: ComputerBot, ref: string, text: string): Promise<void>
    /** PNG bytes. */
    screenshot(bot: ComputerBot): Promise<Uint8Array>
  }
}
