import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Computer, ComputerBot, ScreenBot, ScreenStatus } from '../ports/computer.ts'

/** The parts of the computer the contract covers; the browser joins with its tools. */
export type ContractComputer = Pick<Computer, 'screens' | 'shell'>

/** A computer under test, and what the contract needs to poke at it. */
export type ContractWorld = {
  computer: ContractComputer
  /** A new client of the same computer, as the server gets after restarting. */
  reconnect(): Promise<ContractComputer>
  /** Kills every process of the bot's screen, as a crash would. */
  crash(bot: ScreenBot): Promise<void>
  /** The Unix user bots' commands run as. */
  user: string
  /** The bot's own folder, where its commands start. */
  folder(bot: ComputerBot): string
  close?(): Promise<void>
}

export type ContractOptions = {
  /** Displays the contract's screens use, from here up, so they stay clear of real bots'. */
  firstDisplay?: number
  /** How long a screen may take to come up. */
  timeout?: number
  /** Whether to cover the shell; off for a screen daemon tested on its own. */
  shell?: boolean
}

/** The first bytes of the screen's stream: the VNC protocol's greeting, e.g. `RFB 003.008\n`. */
export function readStreamGreeting(port: number, timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`No greeting on port ${port}`))
    }, timeout)
    socket.once('data', (data) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(data.toString('latin1'))
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

const greeting = /^RFB \d{3}\.\d{3}\n/

/**
 * Seam 2: what every `Computer` must do, run against the in-memory fake and against the real screen daemon in the
 * runtime image.
 */
export function describeComputerContract(name: string, open: () => Promise<ContractWorld>, options: ContractOptions = {}) {
  const timeout = options.timeout ?? 30_000
  let nextDisplay = options.firstDisplay ?? 900
  let world: ContractWorld | undefined
  const started: ScreenBot[] = []

  afterEach(async () => {
    if (!world) return
    for (const bot of started.splice(0)) await world.computer.screens.stop(bot).catch(() => {})
    await world.close?.()
    world = undefined
  })

  async function setup() {
    world = await open()
    return world
  }

  function newBot(label: string): ScreenBot {
    const bot = { id: `contract-${randomUUID()}`, name: label, display: nextDisplay++ }
    started.push(bot)
    return bot
  }

  async function untilRunning(computer: ContractComputer, bot: ComputerBot): Promise<ScreenStatus> {
    await expect.poll(async () => (await computer.screens.status(bot)).state, { timeout, interval: 100 }).toBe('running')
    return computer.screens.status(bot)
  }

  describe(`${name}: the Computer contract`, () => {
    it('starts a screen at its display and streams it', { timeout: timeout * 2 }, async () => {
      const { computer } = await setup()
      const rex = newBot('Rex')

      const starting = await computer.screens.start(rex)
      const running = await untilRunning(computer, rex)

      expect(['starting', 'running']).toContain(starting.state)
      expect(running).toMatchObject({ state: 'running', display: rex.display })
      expect(running.startedAt).toBeTypeOf('number')
      expect(await readStreamGreeting(running.streamPort!)).toMatch(greeting)
      expect(await computer.screens.list()).toContainEqual({ botId: rex.id, ...running })
    })

    it('keeps a running screen when started again', { timeout: timeout * 2 }, async () => {
      const { computer } = await setup()
      const rex = newBot('Rex')
      await computer.screens.start(rex)
      const first = await untilRunning(computer, rex)

      await computer.screens.start(rex)

      expect(await computer.screens.status(rex)).toEqual(first)
    })

    it("keeps each bot's screen apart", { timeout: timeout * 2 }, async () => {
      const { computer } = await setup()
      const rex = newBot('Rex')
      const ada = newBot('Ada')
      await computer.screens.start(rex)
      await computer.screens.start(ada)

      const [ofRex, ofAda] = [await untilRunning(computer, rex), await untilRunning(computer, ada)]

      expect(ofRex.display).not.toBe(ofAda.display)
      expect(ofRex.streamPort).not.toBe(ofAda.streamPort)
    })

    it('restarts a crashed screen', { timeout: timeout * 3 }, async () => {
      const world = await setup()
      const rex = newBot('Rex')
      await world.computer.screens.start(rex)
      const before = await untilRunning(world.computer, rex)

      await world.crash(rex)

      await expect
        .poll(async () => (await world.computer.screens.status(rex)).startedAt, { timeout, interval: 100 })
        .not.toBe(before.startedAt)
      const after = await untilRunning(world.computer, rex)
      expect(after.display).toBe(rex.display)
      expect(await readStreamGreeting(after.streamPort!)).toMatch(greeting)
    })

    it('keeps screens running for a new client, as across a server restart', { timeout: timeout * 2 }, async () => {
      const world = await setup()
      const rex = newBot('Rex')
      await world.computer.screens.start(rex)
      const before = await untilRunning(world.computer, rex)

      const computer = await world.reconnect()

      expect(await computer.screens.status(rex)).toEqual(before)
      expect(await readStreamGreeting(before.streamPort!)).toMatch(greeting)
    })

    it('stops a screen and its stream', { timeout: timeout * 2 }, async () => {
      const { computer } = await setup()
      const rex = newBot('Rex')
      await computer.screens.start(rex)
      const running = await untilRunning(computer, rex)

      await computer.screens.stop(rex)

      expect(await computer.screens.status(rex)).toEqual({ state: 'stopped', display: null, startedAt: null, streamPort: null })
      expect((await computer.screens.list()).map((screen) => screen.botId)).not.toContain(rex.id)
      await expect(readStreamGreeting(running.streamPort!, 1_000)).rejects.toThrow()
    })

    it('reports a screen it was never asked for as stopped', async () => {
      const { computer } = await setup()

      expect(await computer.screens.status({ id: `contract-${randomUUID()}`, name: 'Nobody' })).toEqual({
        state: 'stopped',
        display: null,
        startedAt: null,
        streamPort: null,
      })
    })

    it.runIf(options.shell ?? true)("runs commands as the bots' user, with sudo, in the bot's folder", async () => {
      const world = await setup()
      const rex = { id: `contract-${randomUUID()}`, name: 'Rex' }

      const result = await world.computer.shell.exec(rex, 'whoami; sudo --non-interactive whoami; pwd')
      const failed = await world.computer.shell.exec(rex, 'echo oops >&2; exit 3')

      expect(result).toEqual({ stdout: `${world.user}\nroot\n${world.folder(rex)}\n`, stderr: '', exitCode: 0 })
      expect(failed).toEqual({ stdout: '', stderr: 'oops\n', exitCode: 3 })
    })
  })
}
