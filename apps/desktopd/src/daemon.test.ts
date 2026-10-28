import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectScreens } from '@openbot/computer'
import { createBot, keepScreensInSync } from '@openbot/core'
import { openDb } from '@openbot/db'
import { describeComputerContract } from '@openbot/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { serve } from './http.ts'
import { listening } from './programs.ts'
import { type App, type Program, ScreenManager, type ScreenSpec } from './screen-manager.ts'

// The daemon with stand-in programs, on any machine: a process that idles as the display server, one that greets like
// a VNC server as the stream, and one listening as the browser's DevTools. The real programs run in the runtime image
// (computer.image.test.ts in the webapp).

const streamPort = (display: number) => 41_000 + display
const browserPort = (display: number) => 42_000 + display
const idle = 'setInterval(() => {}, 1 << 30)'

const until = async (check: () => Promise<boolean>) => {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 20))
}

function browser({ display }: ScreenSpec): App {
  const port = browserPort(display)
  return {
    name: 'browser',
    command: process.execPath,
    args: ['-e', `require('node:net').createServer((s) => s.end()).listen(${port}, '127.0.0.1')`],
    ready: () => until(() => listening(port)),
    open: () => listening(port),
  }
}

function programs({ display }: ScreenSpec): Program[] {
  const port = streamPort(display)
  return [
    { name: 'display', command: process.execPath, args: ['-e', idle] },
    { name: 'desktop', command: process.execPath, args: ['-e', idle] },
    {
      name: 'stream',
      command: process.execPath,
      args: ['-e', `require('node:net').createServer((s) => { s.on('error', () => {}); s.end('RFB 003.008\\n') }).listen(${port}, '127.0.0.1')`],
      async ready() {
        while (!(await listening(port))) await new Promise((resolve) => setTimeout(resolve, 20))
      },
    },
  ]
}

type Daemon = { dir: string; manager: ScreenManager; socketPath: string; close(): Promise<void> }

async function startDaemon(dir: string): Promise<Daemon> {
  const manager = new ScreenManager({
    programs,
    browser,
    streamPort,
    profile: (botId) => join(dir, 'bots', botId, 'chromium'),
    stateFile: join(dir, 'screens.json'),
  })
  const socketPath = join(dir, 'desktopd.sock')
  const server = await serve(manager, socketPath)
  await manager.restore()
  return {
    dir,
    manager,
    socketPath,
    async close() {
      server.close()
      await manager.shutdown()
    },
  }
}

function kill(pids: Record<string, number | undefined>, names = Object.keys(pids)) {
  for (const name of names) if (pids[name]) process.kill(pids[name]!, 'SIGKILL')
}

let dirs: string[] = []
let daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function newDaemon() {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-desktopd-'))
  dirs.push(dir)
  const daemon = await startDaemon(dir)
  daemons.push(daemon)
  return daemon
}

/** Stops `daemon` and starts it again on its folder, as supervisord or `node --watch` would. */
async function restartDaemon(daemon: Daemon): Promise<Daemon> {
  await daemon.close()
  daemons = daemons.filter((other) => other !== daemon)
  const restarted = await startDaemon(daemon.dir)
  daemons.push(restarted)
  return restarted
}

describeComputerContract(
  'the screen daemon',
  async () => {
    let daemon = await newDaemon()
    const client = () => ({ screens: connectScreens({ socketPath: daemon.socketPath, checkEvery: 50 }) })
    return {
      computer: client(),
      reconnect: async () => client(),
      crash: async (bot) => kill(daemon.manager.pids(bot.id)),
      restart: async () => {
        daemon = await restartDaemon(daemon)
      },
    }
  },
  { browser: false, desktop: false, timeout: 10_000 },
)

describe('the screen daemon', () => {
  const rex = { botId: 'rex', display: 7 }

  it("restarts just the program that died, keeping the screen's start time", async () => {
    const { manager } = await newDaemon()
    await manager.start(rex)
    await expect.poll(() => manager.status('rex').state).toBe('running')
    const before = { ...manager.status('rex') }
    const pids = manager.pids('rex')

    kill(pids, ['desktop'])

    await expect.poll(() => manager.pids('rex').desktop).not.toBe(pids.desktop)
    await expect.poll(() => manager.status('rex').state).toBe('running')
    expect(manager.status('rex').startedAt).toBe(before.startedAt)
    expect(manager.pids('rex').display).toBe(pids.display)
  })

  it('opens the browser when asked, once, and again after it closed, without restarting the screen', async () => {
    const daemon = await newDaemon()
    const screens = connectScreens({ socketPath: daemon.socketPath })
    const bot = { id: 'rex', name: 'Rex' }
    await screens.start({ ...bot, display: 7 })
    await expect.poll(async () => (await screens.status(bot)).state).toBe('running')
    const startedAt = (await screens.status(bot)).startedAt
    expect(daemon.manager.pids('rex').browser).toBeUndefined()

    await Promise.all([screens.openBrowser(bot), screens.openBrowser(bot)])
    const first = daemon.manager.pids('rex').browser
    expect(first).toBeDefined()
    expect(await listening(browserPort(7))).toBe(true)
    await screens.openBrowser(bot)
    expect(daemon.manager.pids('rex').browser).toBe(first)

    kill(daemon.manager.pids('rex'), ['browser'])
    await expect.poll(() => daemon.manager.pids('rex').browser).toBeUndefined()
    expect(await screens.status(bot)).toMatchObject({ state: 'running', startedAt })

    await screens.openBrowser(bot)
    expect(daemon.manager.pids('rex').browser).not.toBe(first)
    await screens.stop(bot)
    expect(await listening(browserPort(7))).toBe(false)
  })

  it('leaves a browser opened another way, e.g. from the dock, as it is', async () => {
    const daemon = await newDaemon()
    const screens = connectScreens({ socketPath: daemon.socketPath })
    const bot = { id: 'rex', name: 'Rex' }
    await screens.start({ ...bot, display: 7 })
    await expect.poll(async () => (await screens.status(bot)).state).toBe('running')
    const opened = createServer((socket) => socket.end()).listen(browserPort(7), '127.0.0.1')
    await until(() => listening(browserPort(7)))

    await screens.openBrowser(bot)

    expect(daemon.manager.pids('rex').browser).toBeUndefined()
    opened.close()
  })

  it("can't open a browser on a screen that isn't running", async () => {
    const daemon = await newDaemon()
    const screens = connectScreens({ socketPath: daemon.socketPath })

    await expect(screens.openBrowser({ id: 'rex', name: 'Rex' })).rejects.toThrow("The screen isn't running (stopped)")
  })

  it('brings its screens back when it starts again', async () => {
    const first = await newDaemon()
    await first.manager.start(rex)
    await expect.poll(() => first.manager.status('rex').state).toBe('running')

    const second = await restartDaemon(first)

    await expect.poll(() => second.manager.status('rex').state).toBe('running')
    expect(second.manager.status('rex').display).toBe(7)
  })

  it("deletes the bot's browser profile when its screen stops, and gives a display to one screen", async () => {
    const { dir, manager } = await newDaemon()
    await manager.start(rex)
    await expect.poll(() => manager.status('rex').state).toBe('running')
    expect(existsSync(join(dir, 'bots', 'rex', 'chromium'))).toBe(true)

    await manager.start({ botId: 'ada', display: 7 })
    expect(manager.status('rex').state).toBe('stopped')
    await manager.stop('rex')

    expect(existsSync(join(dir, 'bots', 'rex', 'chromium'))).toBe(false)
    expect(manager.list().map((screen) => screen.botId)).toEqual(['ada'])
  })

  it('tells its clients it restarted on their next call, between health checks', async () => {
    const first = await newDaemon()
    const screens = connectScreens({ socketPath: first.socketPath, checkEvery: 60_000 })
    let restarts = 0
    const stopListening = screens.onRestart(() => restarts++)
    await screens.list()

    await restartDaemon(first)
    await screens.status({ id: 'rex', name: 'Rex' })

    expect(restarts).toBe(1)
    stopListening()
  })

  it("gets every bot's screen back on its display from a server keeping them in sync, when it restarts without its saved screens", async () => {
    const first = await newDaemon()
    const db = await openDb(join(first.dir, 'openbot.db'))
    const profile = { title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null } as const
    const bots = [await createBot(db, { name: 'Rex', ...profile }), await createBot(db, { name: 'Ada', ...profile })]
    const screens = connectScreens({ socketPath: first.socketPath, checkEvery: 50 })
    const sync = keepScreensInSync(db, screens)
    await sync.synced
    const running = async () => (await screens.list()).filter(({ state }) => state === 'running').map(({ botId, display }) => ({ botId, display }))
    const expected = bots.map((bot) => ({ botId: bot.id, display: bot.displayNumber }))
    await expect.poll(running).toEqual(expected)

    await first.close()
    daemons = daemons.filter((daemon) => daemon !== first)
    await rm(join(first.dir, 'screens.json'))
    daemons.push(await startDaemon(first.dir))

    await expect.poll(running, { timeout: 5_000 }).toEqual(expected)
    sync.stop()
    db.$client.close()
  })

  it('refuses bot ids that are not plain names', async () => {
    const daemon = await newDaemon()
    const screens = connectScreens({ socketPath: daemon.socketPath })

    await expect(screens.start({ id: '../etc', name: 'Sneaky', display: 3 })).rejects.toThrow('Invalid bot id')
  })
})
