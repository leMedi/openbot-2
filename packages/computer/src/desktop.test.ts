import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ScreenStatus, stoppedScreen } from '@openbot/core'
import { afterEach, describe, expect, it } from 'vitest'
import { connectDesktop, desktopDriverSocket, parseKeys } from './desktop.ts'

// The desktop client against a stand-in driver that answers as cua-driver does on a screen. The real driver is covered
// by the contract suite in the runtime image (computer.image.test.ts in the webapp).

const standIn = fileURLToPath(new URL('./testing/stand-in-cua-driver.mjs', import.meta.url))
const rex = { id: 'bot-rex', name: 'Rex' }
const running: ScreenStatus = { state: 'running', display: 7, startedAt: 1, streamPort: 5907 }

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step()
})

async function connect(status: () => ScreenStatus = () => running) {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-desktop-'))
  const log = join(dir, 'calls.jsonl')
  const sockets: string[] = []
  const desktop = connectDesktop({
    screens: { status: async () => status() },
    command: (socket) => {
      sockets.push(socket)
      return [process.execPath, standIn, log]
    },
  })
  cleanup.push(async () => {
    await desktop.close()
    await rm(dir, { recursive: true, force: true })
  })
  /** What the driver was asked, in order. */
  const calls = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { tool: string; args: Record<string, unknown> })
  return { desktop, calls, sockets }
}

describe('the desktop client', () => {
  it("reaches the driver of the bot's screen", async () => {
    const { desktop, sockets } = await connect()

    expect(await desktop.windows(rex)).toEqual([])
    expect(sockets).toEqual([desktopDriverSocket(7)])
  })

  it('opens an app and waits for its window', async () => {
    const { desktop } = await connect()

    expect(await desktop.open(rex, 'mousepad')).toEqual([{ id: 777, app: 'Mousepad', title: 'Untitled 1 - Mousepad', x: 320, y: 166, width: 640, height: 480 }])
    await expect(desktop.open(rex, 'nothing')).rejects.toThrow(/Couldn't open nothing: .*no app named nothing/)
  })

  it('renders snapshots with references that count up, and acts on elements by their tokens', async () => {
    const { desktop, calls } = await connect()
    await desktop.open(rex, 'mousepad')

    const first = await desktop.snapshot(rex, 777)
    const second = await desktop.snapshot(rex, 777)
    const typed = await desktop.type(rex, { ref: 'd4' }, 'Hello')

    expect(first).toEqual({
      window: { id: 777, app: 'Mousepad', title: 'Untitled 1 - Mousepad', x: 320, y: 166, width: 640, height: 480 },
      tree: '- frame = "Untitled 1 - Mousepad"\n  - [ref=d1] push button "New" [actions=[click]]\n  - push button = "Undo" (disabled)\n  - [ref=d2] text "" [actions=[]]',
    })
    expect(second.tree).toContain('[ref=d3] push button "New"')
    expect(typed).toEqual({ effect: 'confirmed', summary: "Typed into d4; it reads back 'Hello'." })
    expect((await calls()).at(-1)).toEqual({
      tool: 'type_text',
      args: { target: { kind: 'window', pid: 4242, window_id: 777 }, element_token: 's00000002:1', text: 'Hello' },
    })
  })

  it('refuses references from an older snapshot without sending them', async () => {
    const { desktop, calls } = await connect()
    await desktop.open(rex, 'mousepad')
    await desktop.snapshot(rex, 777)
    await desktop.snapshot(rex, 777)
    const before = (await calls()).length

    expect(await desktop.click(rex, { ref: 'd1' })).toEqual({ effect: 'refused', summary: "d1 isn't on the latest snapshot; take a new snapshot and use its references" })
    expect(await desktop.type(rex, { ref: 'd99' }, 'x')).toMatchObject({ effect: 'refused' })
    expect(await calls()).toHaveLength(before)
  })

  it("reports the driver's own stale-token refusal in its words", async () => {
    const { desktop } = await connect()
    await desktop.open(rex, 'mousepad')
    await desktop.snapshot(rex, 777)
    // Another reader of the window (the owner's agent, say) took a snapshot behind the client's back.
    await desktop.screenshot(rex, 777)

    expect(await desktop.click(rex, { ref: 'd1' })).toEqual({
      effect: 'refused',
      summary: "d1 isn't on the latest snapshot of its window any more; take a new snapshot and use its references",
    })
  })

  it('sends keys again in the foreground when the screen refuses them in the background, and typing into focus as keys', async () => {
    const { desktop, calls } = await connect()
    await desktop.open(rex, 'mousepad')

    const pressed = await desktop.press(rex, 777, 'ctrl+A')
    const typed = await desktop.type(rex, { window: 777 }, 'Bye')

    expect(pressed).toEqual({ effect: 'unverifiable', summary: 'Pressed ["ctrl","A"].' })
    expect(typed).toEqual({ effect: 'unverifiable', summary: 'Typed as real key events. Read the field before typing again.' })
    expect((await calls()).filter((call) => call.tool === 'hotkey').map((call) => call.args.delivery_mode)).toEqual([undefined, 'foreground'])
    // Typing into what has focus goes as real keys at once, so it replaces a selection as typing does.
    expect((await calls()).filter((call) => call.tool === 'type_text').map((call) => call.args.delivery_mode)).toEqual(['foreground'])
  })

  it('reports refusals and other effects as they come', async () => {
    const { desktop } = await connect()
    await desktop.open(rex, 'mousepad')

    expect(await desktop.scroll(rex, { window: 777 }, 'down')).toEqual({ effect: 'suspected_noop', summary: 'Scrolled; nothing moved.' })
    expect(await desktop.click(rex, { window: 777, x: 10, y: 10 })).toMatchObject({ effect: 'refused', summary: expect.stringMatching(/no current screenshot/) })
  })

  it('takes screenshots of a window and of the screen', async () => {
    const { desktop } = await connect()
    await desktop.open(rex, 'mousepad')

    for (const shot of [await desktop.screenshot(rex, 777), await desktop.screenshot(rex)]) expect([...shot.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it("can't reach the desktop of a screen that isn't running", async () => {
    const { desktop } = await connect(() => stoppedScreen)

    await expect(desktop.windows(rex)).rejects.toThrow("Rex's screen isn't running (stopped)")
  })

  it('sends a read again on a new client when the driver went away under it, but not an action', async () => {
    const { desktop, sockets, calls } = await connect()
    await desktop.windows(rex)

    // The first driver exits during the launch, as when its screen's cua-driver restarts: the app may have started.
    await expect(desktop.open(rex, 'exit')).rejects.toThrow(/went away during launch_app, so exit may or may not have started/)
    expect(await desktop.windows(rex)).toEqual([])

    expect(sockets).toHaveLength(2)
    expect((await calls()).filter((call) => call.tool === 'launch_app')).toHaveLength(1)
  })

  it('refuses actions on a window the screen no longer has', async () => {
    const { desktop } = await connect()
    await desktop.open(rex, 'mousepad')

    for (const result of [await desktop.press(rex, 999, 'Return'), await desktop.type(rex, { window: 999 }, 'x'), await desktop.click(rex, { window: 999, x: 1, y: 1 })]) {
      expect(result).toEqual({ effect: 'refused', summary: "There's no window 999 on Rex's screen; list the windows again" })
    }
  })
})

describe('keys', () => {
  it('splits combinations and names keys as the driver does', () => {
    expect(parseKeys('Return')).toEqual(['return'])
    expect(parseKeys('ctrl+s')).toEqual(['ctrl', 's'])
    expect(parseKeys('Ctrl + Shift + T')).toEqual(['ctrl', 'shift', 'T'])
  })
})
