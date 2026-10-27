import { createServer, type Server } from 'node:net'
import { type BrowserSnapshot, type Computer, type ComputerBot, type ExecResult, type ScreenStatus, stoppedScreen } from '../ports/computer.ts'

export type ComputerCall =
  | { bot: string; kind: 'screens.start'; display: number }
  | { bot: string; kind: 'screens.stop' | 'browser.snapshot' | 'browser.screenshot' }
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
  /** Kills the bot's screen; it comes back at once, as the daemon restarts it. */
  crash(bot: ComputerBot): Promise<void>
  /** Closes every screen's stream. */
  close(): Promise<void>
}

type FakeScreen = { display: number; startedAt: number; stream: Server; streamPort: number }

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
  const pages = new Map<string, string>()
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
    if (screen) await closeStream(screen.stream)
  }

  return {
    calls,
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
