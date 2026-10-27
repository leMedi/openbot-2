import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type BrowserSnapshot,
  type Computer,
  type ComputerBot,
  type DesktopActionResult,
  desktopEffects,
  type DesktopSnapshot,
  type ScreenBot,
  type ScreenStatus,
} from '../ports/computer.ts'
import type { TestPage } from './pages.ts'

/** The parts of the computer the contract covers; a screen daemon tested on its own has no browser or desktop to drive. */
export type ContractComputer = Pick<Computer, 'screens' | 'shell'> & Partial<Pick<Computer, 'browser' | 'desktop'>>

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
  /** Puts `page` where the computer's browsers can load it; returns its URL. Needed to cover the browser. */
  page?(name: string, page: TestPage): string
  /**
   * What opens a text editor on the computer's screens (Mousepad on the real one): one window whose accessibility tree
   * has a `text` element holding the document and a `push button "New"` that opens another document as a
   * `page tab`. Needed to cover the desktop.
   */
  editor?: string
  close?(): Promise<void>
}

export type ContractOptions = {
  /** Displays the contract's screens use, from here up, so they stay clear of real bots'. */
  firstDisplay?: number
  /** How long a screen may take to come up. */
  timeout?: number
  /** Whether to cover the shell; off for a screen daemon tested on its own. */
  shell?: boolean
  /** Whether to cover the browser; off for a screen daemon tested with stand-in programs. */
  browser?: boolean
  /** Whether to cover the desktop; off for a screen daemon tested with stand-in programs. */
  desktop?: boolean
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

/** The reference of the element on a snapshot's line `- <role> "<name>" [ref=eN]`. */
export function refOf(snapshot: BrowserSnapshot, role: string, name: string): string {
  const line = snapshot.tree.split('\n').find((text) => text.trimStart().startsWith(`- ${role} ${JSON.stringify(name)} [ref=`))
  const ref = line?.match(/\[ref=(e\d+)\]/)?.[1]
  if (!ref) throw new Error(`No ${role} "${name}" on the snapshot of ${snapshot.url}:\n${snapshot.tree}`)
  return ref
}

/** The reference of the first element on a desktop snapshot's line `- [ref=dN] <role> "<name>…`. */
export function desktopRefOf(snapshot: DesktopSnapshot, role: string, name?: string): string {
  const line = snapshot.tree
    .split('\n')
    .find((text) => /^\s*- \[ref=d\d+\] /.test(text) && text.replace(/^\s*- \[ref=d\d+\] /, '').startsWith(`${role} ${name === undefined ? '"' : JSON.stringify(name)}`))
  const ref = line?.match(/\[ref=(d\d+)\]/)?.[1]
  if (!ref) throw new Error(`No ${role}${name === undefined ? '' : ` "${name}"`} on the snapshot of ${snapshot.window.title}:\n${snapshot.tree}`)
  return ref
}

/** An action whose effect is reported, and that was delivered. */
function delivered(result: DesktopActionResult) {
  expect(desktopEffects).toContain(result.effect)
  expect(result.effect, result.summary).not.toBe('refused')
  expect(result.summary).toBeTypeOf('string')
}

const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

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

    describe.runIf(options.browser ?? true)('the browser', () => {
      /** A bot whose screen is running, and two linked pages. */
      async function browsing() {
        const world = await setup()
        const rex = newBot('Rex')
        await world.computer.screens.start(rex)
        await untilRunning(world.computer, rex)
        const page = world.page!.bind(world)
        const next = page('next', { title: 'Next page', elements: [{ role: 'heading', name: 'You made it' }] })
        const home = page('home', {
          title: 'Home',
          elements: [
            { role: 'heading', name: 'Welcome' },
            { role: 'link', name: 'Next', href: next },
            { role: 'textbox', name: 'Search' },
          ],
        })
        return { world, browser: world.computer.browser!, rex, home, next }
      }

      it('navigates, and snapshots the page with element references', { timeout: timeout * 2 }, async () => {
        const { browser, rex, home } = await browsing()

        await browser.navigate(rex, home)
        const snapshot = await browser.snapshot(rex)

        expect(snapshot).toMatchObject({ url: home, title: 'Home' })
        expect(snapshot.tree).toMatch(/- heading "Welcome" \[ref=e\d+\]/)
        expect(snapshot.tree).toMatch(/- link "Next" \[ref=e\d+\]/)
        expect(snapshot.tree).toMatch(/- textbox "Search" \[ref=e\d+\]/)
      })

      it('types into fields and clicks links by reference', { timeout: timeout * 2 }, async () => {
        const { browser, rex, home, next } = await browsing()
        await browser.navigate(rex, home)

        await browser.type(rex, refOf(await browser.snapshot(rex), 'textbox', 'Search'), 'hello')
        const typed = await browser.snapshot(rex)
        await browser.click(rex, refOf(typed, 'link', 'Next'))
        const clicked = await browser.snapshot(rex)

        expect(typed.tree).toMatch(/- textbox "Search" \[ref=e\d+\]: hello/)
        expect(clicked).toMatchObject({ url: next, title: 'Next page' })
        expect(clicked.tree).toMatch(/- heading "You made it"/)
      })

      it('refuses element references from an older snapshot', { timeout: timeout * 2 }, async () => {
        const { browser, rex, home, next } = await browsing()
        await browser.navigate(rex, home)
        const old = refOf(await browser.snapshot(rex), 'link', 'Next')
        const latest = refOf(await browser.snapshot(rex), 'link', 'Next')

        await expect(browser.click(rex, old)).rejects.toThrow(/latest snapshot/)
        await expect(browser.type(rex, old, 'hello')).rejects.toThrow(/latest snapshot/)
        await expect(browser.click(rex, 'e99999')).rejects.toThrow(/latest snapshot/)
        await browser.click(rex, latest)
        expect((await browser.snapshot(rex)).url).toBe(next)
      })

      it('opens, lists, selects and closes tabs', { timeout: timeout * 2 }, async () => {
        const { browser, rex, home, next } = await browsing()
        await browser.navigate(rex, home)
        const [first] = await browser.tabs(rex)

        const opened = await browser.newTab(rex, next)
        const both = await browser.tabs(rex)
        const onNew = await browser.snapshot(rex)
        await browser.selectTab(rex, first!.id)
        const onFirst = await browser.snapshot(rex)
        await browser.closeTab(rex, opened.id)

        expect(opened).toMatchObject({ url: next, active: true })
        expect(both.map((tab) => [tab.id, tab.active]).sort()).toEqual(
          [
            [first!.id, false],
            [opened.id, true],
          ].sort(),
        )
        expect(onNew.url).toBe(next)
        expect(onFirst.url).toBe(home)
        expect(await browser.tabs(rex)).toEqual([{ id: first!.id, url: home, title: 'Home', active: true }])
      })

      it("refuses references from another tab's snapshot", { timeout: timeout * 2 }, async () => {
        const { browser, rex, home } = await browsing()
        await browser.navigate(rex, home)
        const ref = refOf(await browser.snapshot(rex), 'link', 'Next')

        await browser.newTab(rex, home)

        await expect(browser.click(rex, ref)).rejects.toThrow(/latest snapshot/)
      })

      it('takes screenshots as PNG', { timeout: timeout * 2 }, async () => {
        const { browser, rex, home } = await browsing()
        await browser.navigate(rex, home)

        const screenshot = await browser.screenshot(rex)

        expect([...screenshot.subarray(0, 8)]).toEqual(png)
      })

      it("keeps each bot's browser apart", { timeout: timeout * 3 }, async () => {
        const { world, browser, rex, home, next } = await browsing()
        const ada = newBot('Ada')
        await world.computer.screens.start(ada)
        await untilRunning(world.computer, ada)

        await browser.navigate(rex, home)
        await browser.navigate(ada, next)

        expect((await browser.snapshot(rex)).url).toBe(home)
        expect((await browser.snapshot(ada)).url).toBe(next)
      })

      it("can't browse without a running screen", async () => {
        const world = await setup()

        await expect(world.computer.browser!.snapshot({ id: `contract-${randomUUID()}`, name: 'Nobody' })).rejects.toThrow(/screen/)
      })
    })

    describe.runIf(options.desktop ?? true)('the desktop', () => {
      /** A bot whose screen is running, with the editor open. */
      async function editing() {
        const world = await setup()
        const rex = newBot('Rex')
        await world.computer.screens.start(rex)
        await untilRunning(world.computer, rex)
        const desktop = world.computer.desktop!
        const [window] = await desktop.open(rex, world.editor!)
        if (!window) throw new Error(`${world.editor} showed no window`)
        return { world, desktop, rex, window }
      }

      it('opens an app and lists its window', { timeout: timeout * 2 }, async () => {
        const { desktop, rex, window } = await editing()

        expect(window).toMatchObject({ id: expect.any(Number), app: expect.any(String), title: expect.any(String) })
        expect(window.width).toBeGreaterThan(0)
        expect((await desktop.windows(rex)).map((each) => each.id)).toContain(window.id)
      })

      it('snapshots a window with element references, and types into a field, confirmed', { timeout: timeout * 2 }, async () => {
        const { desktop, rex, window } = await editing()

        const snapshot = await desktop.snapshot(rex, window.id)
        const typed = await desktop.type(rex, { ref: desktopRefOf(snapshot, 'text') }, 'Hello from Rex')
        const after = await desktop.snapshot(rex, window.id)

        expect(snapshot.window.id).toBe(window.id)
        expect(snapshot.tree).toMatch(/- \[ref=d\d+\] push button "New"/)
        expect(typed.effect).toBe('confirmed')
        expect(after.tree).toMatch(/- \[ref=d\d+\] text "Hello from Rex/)
      })

      it('clicks elements by reference', { timeout: timeout * 2 }, async () => {
        const { desktop, rex, window } = await editing()
        const tabs = (snapshot: DesktopSnapshot) => snapshot.tree.split('\n').filter((line) => /- (\[ref=d\d+\] )?page tab /.test(line)).length
        const before = await desktop.snapshot(rex, window.id)

        delivered(await desktop.click(rex, { ref: desktopRefOf(before, 'push button', 'New') }))

        await expect.poll(async () => tabs(await desktop.snapshot(rex, window.id)), { timeout }).toBe(tabs(before) + 1)
      })

      it('presses keys and types into what has focus in a window', { timeout: timeout * 2 }, async () => {
        const { desktop, rex, window } = await editing()
        await desktop.type(rex, { ref: desktopRefOf(await desktop.snapshot(rex, window.id), 'text') }, 'Hello')

        delivered(await desktop.press(rex, window.id, 'ctrl+a'))
        delivered(await desktop.type(rex, { window: window.id }, 'Bye'))

        await expect.poll(async () => (await desktop.snapshot(rex, window.id)).tree, { timeout }).toMatch(/text "Bye/)
        expect((await desktop.snapshot(rex, window.id)).tree).not.toMatch(/Hello/)
      })

      it('scrolls a window', { timeout: timeout * 2 }, async () => {
        const { desktop, rex, window } = await editing()

        delivered(await desktop.scroll(rex, { window: window.id }, 'down', 3))
      })

      it('refuses element references from an older snapshot, as an effect', { timeout: timeout * 2 }, async () => {
        const { desktop, rex, window } = await editing()
        const old = desktopRefOf(await desktop.snapshot(rex, window.id), 'push button', 'New')
        await desktop.snapshot(rex, window.id)

        const clicked = await desktop.click(rex, { ref: old })
        const typed = await desktop.type(rex, { ref: old }, 'hello')
        const madeUp = await desktop.click(rex, { ref: 'd99999' })

        for (const result of [clicked, typed, madeUp]) {
          expect(result.effect).toBe('refused')
          expect(result.summary).toMatch(/latest snapshot/)
        }
      })

      it('takes screenshots of a window and of the screen as PNG, and clicks points of a window', { timeout: timeout * 2 }, async () => {
        const { desktop, rex, window } = await editing()

        const ofWindow = await desktop.screenshot(rex, window.id)
        const ofScreen = await desktop.screenshot(rex)
        const clicked = await desktop.click(rex, { window: window.id, x: Math.round(window.width / 2), y: Math.round(window.height / 2) })

        expect([...ofWindow.subarray(0, 8)]).toEqual(png)
        expect([...ofScreen.subarray(0, 8)]).toEqual(png)
        delivered(clicked)
      })

      it("keeps each bot's desktop apart", { timeout: timeout * 3 }, async () => {
        const { world, desktop, window } = await editing()
        const ada = newBot('Ada')
        await world.computer.screens.start(ada)
        await untilRunning(world.computer, ada)

        expect((await desktop.windows(ada)).map((each) => each.app)).not.toContain(window.app)
      })

      it("can't reach the desktop without a running screen", async () => {
        const world = await setup()
        const nobody = { id: `contract-${randomUUID()}`, name: 'Nobody' }

        await expect(world.computer.desktop!.windows(nobody)).rejects.toThrow(/screen/)
        await expect(world.computer.desktop!.open(nobody, world.editor!)).rejects.toThrow(/screen/)
      })
    })
  })
}
