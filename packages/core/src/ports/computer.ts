/** Which bot's screen, folder and browser a call targets. */
export type ComputerBot = { id: string; handle: string }

export type ScreenStatus = { state: 'stopped' | 'starting' | 'running' | 'crashed'; display: number | null }

export type ExecResult = { stdout: string; stderr: string; exitCode: number }

/** An accessibility snapshot of the bot's current page, with `[ref=eN]` element references. */
export type BrowserSnapshot = { url: string; title: string; tree: string }

/**
 * The machine all bots share. The real implementation (`@openbot/computer`) talks to the screen daemon and to
 * Chromium over CDP; Seam 1 tests use the in-memory fake from `@openbot/core/testing`.
 */
export interface Computer {
  screens: {
    start(bot: ComputerBot): Promise<ScreenStatus>
    stop(bot: ComputerBot): Promise<void>
    status(bot: ComputerBot): Promise<ScreenStatus>
  }
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
