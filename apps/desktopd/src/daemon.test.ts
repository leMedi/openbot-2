import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectScreens } from '@openbot/computer'
import { describeComputerContract } from '@openbot/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { serve } from './http.ts'
import { listening } from './programs.ts'
import { type Program, ScreenManager, type ScreenSpec } from './screen-manager.ts'

// The daemon with stand-in programs, on any machine: a process that idles as the display server, and one that greets
// like a VNC server as the stream. The real programs run in the runtime image (computer.image.test.ts in the webapp).

const streamPort = (display: number) => 41_000 + display
const idle = 'setInterval(() => {}, 1 << 30)'

function programs({ display }: ScreenSpec): Program[] {
  const port = streamPort(display)
  return [
    { name: 'display', command: process.execPath, args: ['-e', idle] },
    { name: 'browser', command: process.execPath, args: ['-e', idle] },
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

describeComputerContract(
  'the screen daemon',
  async () => {
    const daemon = await newDaemon()
    return {
      computer: { screens: connectScreens({ socketPath: daemon.socketPath }) },
      reconnect: async () => ({ screens: connectScreens({ socketPath: daemon.socketPath }) }),
      crash: async (bot) => kill(daemon.manager.pids(bot.id)),
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

    kill(pids, ['browser'])

    await expect.poll(() => manager.pids('rex').browser).not.toBe(pids.browser)
    await expect.poll(() => manager.status('rex').state).toBe('running')
    expect(manager.status('rex').startedAt).toBe(before.startedAt)
    expect(manager.pids('rex').display).toBe(pids.display)
  })

  it('brings its screens back when it starts again', async () => {
    const first = await newDaemon()
    await first.manager.start(rex)
    await expect.poll(() => first.manager.status('rex').state).toBe('running')
    await first.close()
    daemons = daemons.filter((daemon) => daemon !== first)

    const second = await startDaemon(first.dir)
    daemons.push(second)

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

  it('refuses bot ids that are not plain names', async () => {
    const daemon = await newDaemon()
    const screens = connectScreens({ socketPath: daemon.socketPath })

    await expect(screens.start({ id: '../etc', name: 'Sneaky', display: 3 })).rejects.toThrow('Invalid bot id')
  })
})
