import type { BrowserSnapshot, Computer, ComputerBot, ExecResult, ScreenStatus } from '../ports/computer.ts'

export type ComputerCall =
  | { bot: string; kind: 'screens.start' | 'screens.stop' | 'browser.snapshot' | 'browser.screenshot' }
  | { bot: string; kind: 'shell.exec'; command: string }
  | { bot: string; kind: 'browser.navigate'; url: string }
  | { bot: string; kind: 'browser.click'; ref: string }
  | { bot: string; kind: 'browser.type'; ref: string; text: string }

export type FakeComputerScript = {
  /** Result for a command; `undefined` falls back to an empty success. */
  shell?: (command: string, bot: ComputerBot) => ExecResult | undefined
}

export type FakeComputer = Computer & {
  /** Every side-effecting call, in order, keyed by bot name. Status reads are not recorded. */
  readonly calls: ComputerCall[]
}

/** An in-memory computer that records calls instead of running anything. */
export function createFakeComputer(script: FakeComputerScript = {}): FakeComputer {
  const calls: ComputerCall[] = []
  const displays = new Map<string, number>()
  const running = new Set<string>()
  const pages = new Map<string, string>()

  const status = (bot: ComputerBot): ScreenStatus => ({
    state: running.has(bot.id) ? 'running' : 'stopped',
    display: displays.get(bot.id) ?? null,
  })

  return {
    calls,
    screens: {
      async start(bot) {
        calls.push({ bot: bot.name, kind: 'screens.start' })
        if (!displays.has(bot.id)) displays.set(bot.id, 100 + displays.size)
        running.add(bot.id)
        return status(bot)
      },
      async stop(bot) {
        calls.push({ bot: bot.name, kind: 'screens.stop' })
        running.delete(bot.id)
      },
      async status(bot) {
        return status(bot)
      },
    },
    shell: {
      async exec(bot, command) {
        calls.push({ bot: bot.name, kind: 'shell.exec', command })
        return script.shell?.(command, bot) ?? { stdout: '', stderr: '', exitCode: 0 }
      },
    },
    browser: {
      async snapshot(bot): Promise<BrowserSnapshot> {
        calls.push({ bot: bot.name, kind: 'browser.snapshot' })
        return { url: pages.get(bot.id) ?? 'about:blank', title: '', tree: '' }
      },
      async navigate(bot, url) {
        calls.push({ bot: bot.name, kind: 'browser.navigate', url })
        pages.set(bot.id, url)
      },
      async click(bot, ref) {
        calls.push({ bot: bot.name, kind: 'browser.click', ref })
      },
      async type(bot, ref, text) {
        calls.push({ bot: bot.name, kind: 'browser.type', ref, text })
      },
      async screenshot(bot) {
        calls.push({ bot: bot.name, kind: 'browser.screenshot' })
        return new Uint8Array()
      },
    },
  }
}
