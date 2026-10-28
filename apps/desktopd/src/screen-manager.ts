import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ScreenListing, ScreenState, ScreenStatus } from '@openbot/core'

/** One process of a screen, e.g. its display server or its browser. */
export type Program = {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Resolves once the program is up, e.g. its socket exists; the next program starts after. */
  ready?(): Promise<void>
}

/**
 * A program a screen opens when it's needed rather than keeps running, e.g. its browser: it may close, or have been
 * opened another way (by the bot, from the dock), without the screen restarting.
 */
export type App = Program & {
  /** Whether it is open, however it was opened. */
  open(): Promise<boolean>
}

export type ScreenSpec = { botId: string; display: number }

/** The bot's screen isn't running, so nothing can be opened on it. */
export class ScreenNotRunningError extends Error {}

export type ScreenManagerOptions = {
  /** The processes of a screen, display server first: when it dies, the whole screen restarts. */
  programs(screen: ScreenSpec): Program[]
  /** The screen's browser, opened by `openBrowser`. */
  browser?(screen: ScreenSpec): App
  /** The local port of the screen's stream. */
  streamPort(display: number): number
  /** The bot's browser profile folder, made before its screen starts; deleted when the screen is stopped for good. */
  profile(botId: string): string
  /** Clears what a screen left behind at this display, e.g. a lock file after the daemon itself was killed. */
  cleanup?(display: number): Promise<void>
  /** Where the screens to keep are written, so they come back when the daemon starts again. */
  stateFile: string
  log?(message: string): void
}

const restartDelaysMs = [250, 500, 1_000, 2_000, 5_000, 10_000]
/** A screen up this long has its restart delay reset. */
const stableAfterMs = 60_000
const stopGraceMs = 3_000

type Running = { program: Program; child: ChildProcess; exited: Promise<void>; done: boolean; killed: boolean; supervised: boolean }

class Screen {
  state: ScreenState = 'starting'
  startedAt = Date.now()
  readonly #options: ScreenManagerOptions
  #processes: Running[] = []
  /** The apps it opened, which close without the screen restarting. */
  #apps: Running[] = []
  /** The browser being opened, which a second call waits for. */
  #openingBrowser: Promise<void> | undefined
  #stopping = false
  #crashes = 0
  #lastCrash = 0
  #recovery: Promise<void> | undefined
  /** Something crashed during a recovery; another follows it. */
  #crashedAgain = false
  #timer: ReturnType<typeof setTimeout> | undefined

  readonly spec: ScreenSpec

  constructor(spec: ScreenSpec, options: ScreenManagerOptions) {
    this.spec = spec
    this.#options = options
  }

  status(): ScreenStatus {
    return {
      state: this.state,
      display: this.spec.display,
      startedAt: this.startedAt,
      streamPort: this.#options.streamPort(this.spec.display),
    }
  }

  /** The processes' ids, for diagnostics and tests. */
  pids(): Record<string, number | undefined> {
    const alive = [...this.#processes, ...this.#apps].filter((entry) => !entry.done)
    return Object.fromEntries(alive.map((entry) => [entry.program.name, entry.child.pid]))
  }

  /** Opens the screen's browser unless it is open; resolves once it is up. */
  openBrowser(): Promise<void> {
    this.#openingBrowser ??= this.#openBrowser().finally(() => (this.#openingBrowser = undefined))
    return this.#openingBrowser
  }

  async #openBrowser(): Promise<void> {
    if (this.state !== 'running') throw new ScreenNotRunningError(`The screen isn't running (${this.state})`)
    const browser = this.#options.browser?.(this.spec)
    if (!browser) throw new Error('This screen has no browser')
    if (await browser.open()) return
    this.#apps = this.#apps.filter((entry) => !entry.done)
    await this.#launch(browser, { supervised: false })
  }

  /** Starts every program in order, waiting for each to be ready. */
  async boot(): Promise<void> {
    this.state = 'starting'
    this.startedAt = Date.now()
    try {
      await this.#options.cleanup?.(this.spec.display)
      await mkdir(this.#options.profile(this.spec.botId), { recursive: true })
      for (const program of this.#options.programs(this.spec)) {
        if (this.#stopping) return
        await this.#launch(program)
      }
      if (!this.#stopping && this.#processes.every((entry) => !entry.done)) this.state = 'running'
    } catch (error) {
      this.#log(`couldn't start: ${(error as Error).message}`)
      this.#crashed()
    }
  }

  /** Starts `program`; a supervised one that exits is a crash, after which it restarts. */
  async #launch(program: Program, { supervised = true } = {}): Promise<void> {
    const child = spawn(program.command, program.args, {
      env: { ...process.env, ...program.env },
      // Its own process group, so stopping it also stops what it started (Chrome's many processes).
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const entry: Running = { program, child, done: false, killed: false, supervised, exited: Promise.resolve() }
    entry.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        entry.done = true
        resolve()
        if (this.#stopping || entry.killed) return
        this.#log(`${program.name} exited (${signal ?? code})`)
        if (supervised) this.#crashed()
      })
      child.once('error', (error) => {
        this.#log(`${program.name} failed: ${error.message}`)
        if (child.pid === undefined) {
          entry.done = true
          resolve()
          if (!this.#stopping && supervised) this.#crashed()
        }
      })
    })
    // Kept for `pnpm dev:logs`, prefixed so each screen's lines can be told apart.
    const relay = (data: Buffer) => {
      for (const line of data.toString('utf8').split('\n')) if (line.trim()) this.#log(`${program.name}: ${line}`, true)
    }
    child.stdout?.on('data', relay)
    child.stderr?.on('data', relay)
    if (supervised) this.#processes.push(entry)
    else this.#apps.push(entry)
    if (program.ready) {
      await Promise.race([
        program.ready(),
        entry.exited.then(() => {
          throw new Error(`${program.name} exited while starting`)
        }),
      ])
    }
  }

  /**
   * One of the screen's processes died: once things settle, the display server's death restarts the whole screen and
   * any other's restarts just that program, after a delay that grows while it keeps crashing.
   */
  #crashed() {
    if (this.#stopping || this.#timer) return
    if (this.#recovery) {
      this.#crashedAgain = true
      return
    }
    this.state = 'crashed'
    const now = Date.now()
    if (now - this.#lastCrash > stableAfterMs) this.#crashes = 0
    this.#lastCrash = now
    const delay = restartDelaysMs[Math.min(this.#crashes++, restartDelaysMs.length - 1)]!
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#recovery = this.#recover().finally(() => {
        this.#recovery = undefined
        if (this.#crashedAgain) {
          this.#crashedAgain = false
          this.#crashed()
        }
      })
    }, delay)
  }

  async #recover(): Promise<void> {
    if (this.#stopping) return
    const displayServer = this.#processes[0]
    if (!displayServer || displayServer.done) {
      this.#log('restarting the screen')
      await this.#killAll()
      this.#processes = []
      this.#apps = []
      await this.boot()
      return
    }
    const dead = this.#processes.filter((entry) => entry.done)
    this.#processes = this.#processes.filter((entry) => !entry.done)
    try {
      for (const { program } of dead) {
        this.#log(`restarting ${program.name}`)
        await this.#launch(program)
      }
      if (this.#processes.every((entry) => !entry.done)) this.state = 'running'
    } catch (error) {
      this.#log(`couldn't restart: ${(error as Error).message}`)
      this.#crashed()
    }
  }

  async #killAll(): Promise<void> {
    const alive = [...this.#processes, ...this.#apps].filter((entry) => !entry.done)
    for (const entry of alive) {
      entry.killed = true
      signal(entry.child, 'SIGTERM')
    }
    const killer = setTimeout(() => alive.forEach((entry) => signal(entry.child, 'SIGKILL')), stopGraceMs)
    await Promise.all(alive.map((entry) => entry.exited))
    clearTimeout(killer)
  }

  async stop(): Promise<void> {
    this.#stopping = true
    clearTimeout(this.#timer)
    await this.#recovery
    await this.#killAll()
    this.state = 'stopped'
  }

  #log(message: string, quiet = false) {
    if (quiet && !process.env.OPENBOT_DESKTOPD_VERBOSE) return
    this.#options.log?.(`[screen ${this.spec.display} ${this.spec.botId}] ${message}`)
  }
}

function signal(child: ChildProcess, name: NodeJS.Signals) {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, name)
  } catch {
    try {
      child.kill(name)
    } catch {
      // Already gone.
    }
  }
}

// @openbot/core's `stoppedScreen`, repeated: the daemon imports nothing at runtime.
const stopped: ScreenStatus = { state: 'stopped', display: null, startedAt: null, streamPort: null }

/** Keeps every bot's screen running: starts, restarts on crash, restores after the daemon restarts, stops. */
export class ScreenManager {
  readonly #options: ScreenManagerOptions
  readonly #screens = new Map<string, Screen>()
  /** Requests for one bot run one after another. */
  readonly #queues = new Map<string, Promise<unknown>>()
  #saving = Promise.resolve()
  #shuttingDown = false

  constructor(options: ScreenManagerOptions) {
    this.#options = options
  }

  #serial<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(botId) ?? Promise.resolve()).catch(() => {}).then(work)
    this.#queues.set(botId, next)
    void next.finally(() => this.#queues.get(botId) === next && this.#queues.delete(botId)).catch(() => {})
    return next
  }

  status(botId: string): ScreenStatus {
    return this.#screens.get(botId)?.status() ?? stopped
  }

  list(): ScreenListing[] {
    return [...this.#screens.values()].map((screen) => ({ botId: screen.spec.botId, ...screen.status() }))
  }

  pids(botId: string): Record<string, number | undefined> {
    return this.#screens.get(botId)?.pids() ?? {}
  }

  /** Opens the bot's browser on its screen unless it is open; a `ScreenNotRunningError` when the screen isn't running. */
  openBrowser(botId: string): Promise<void> {
    const screen = this.#screens.get(botId)
    if (!screen) return Promise.reject(new ScreenNotRunningError("The screen isn't running (stopped)"))
    return screen.openBrowser()
  }

  /** Starts the bot's screen at `display` without waiting for it to be up, or keeps it if it already runs there. */
  start(spec: ScreenSpec): Promise<ScreenStatus> {
    return this.#serial(spec.botId, async () => {
      if (this.#shuttingDown) throw new Error('The screen daemon is stopping')
      const current = this.#screens.get(spec.botId)
      if (current?.spec.display === spec.display) return current.status()
      if (current) await this.#remove(spec.botId, { deleteProfile: false })
      // A display belongs to one screen: the server gave it to this bot, so whoever held it is gone.
      // Not through the other bot's queue: two bots swapping displays would each wait for the other.
      for (const other of [...this.#screens.values()]) {
        if (other.spec.display === spec.display) await this.#remove(other.spec.botId, { deleteProfile: false })
      }
      const screen = new Screen(spec, this.#options)
      this.#screens.set(spec.botId, screen)
      await this.#save()
      void screen.boot()
      return screen.status()
    })
  }

  /** Stops the bot's screen and deletes its browser profile. */
  stop(botId: string): Promise<void> {
    return this.#serial(botId, () => this.#remove(botId, { deleteProfile: true }))
  }

  async #remove(botId: string, { deleteProfile }: { deleteProfile: boolean }) {
    const screen = this.#screens.get(botId)
    if (!screen) {
      if (deleteProfile) await rm(this.#options.profile(botId), { recursive: true, force: true })
      return
    }
    this.#screens.delete(botId)
    await this.#save()
    await screen.stop()
    if (deleteProfile) await rm(this.#options.profile(botId), { recursive: true, force: true })
  }

  /** Starts the screens kept before the daemon last stopped. */
  async restore(): Promise<void> {
    let specs: ScreenSpec[] = []
    try {
      specs = (JSON.parse(await readFile(this.#options.stateFile, 'utf8')) as { screens: ScreenSpec[] }).screens
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#options.log?.(`couldn't read ${this.#options.stateFile}: ${(error as Error).message}`)
    }
    for (const spec of specs) await this.start(spec)
  }

  /** Stops every screen's processes but keeps the list, for the next start; when the daemon itself stops. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true
    // Requests already under way finish first, so no screen starts after the rest have stopped.
    await Promise.all([...this.#queues.values()].map((queued) => queued.catch(() => {})))
    await this.#saving
    await Promise.all([...this.#screens.values()].map((screen) => screen.stop()))
  }

  #save(): Promise<void> {
    const screens = [...this.#screens.values()].map((screen) => screen.spec)
    this.#saving = this.#saving.then(async () => {
      const file = this.#options.stateFile
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, `${JSON.stringify({ screens }, null, 2)}\n`)
      await rename(`${file}.tmp`, file)
    })
    return this.#saving
  }
}
