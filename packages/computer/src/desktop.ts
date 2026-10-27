import { userInfo } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type ComputerBot,
  type Desktop,
  type DesktopActionResult,
  type DesktopEffect,
  desktopEffects,
  type DesktopElement,
  type DesktopPoint,
  DesktopUnavailableError,
  type DesktopWindow,
  type DesktopWindowTarget,
  type Screens,
} from '@openbot/core'
import { McpClient, type McpToolResult } from './mcp.ts'

/** Where a screen's cua-driver listens. Duplicated from apps/desktopd/src/programs.ts, which imports nothing. */
export const desktopDriverSocket = (display: number) => `/tmp/openbot-cua-driver-${display}.sock`

/** The driver went away during an action, which may or may not have landed. */
class DriverGone extends Error {}

/** How long an opened app may take to show a window. */
const openTimeoutMs = 10_000

export type DesktopOptions = {
  screens: Pick<Screens, 'status'>
  /**
   * The user every screen's cua-driver runs as. It only answers its own user, so when the server is someone else (as
   * `openbot-server` is in the runtime image) the client runs through sudo as that user.
   */
  runAs?: string
  /** What starts a client of the driver at `socket`; tests swap in a stand-in. */
  command?(socket: string): string[]
}

/** What a reference of the latest snapshot points at: an element of one window, by cua-driver's element token. */
type RefTarget = { token: string; pid: number; window: number }

/** What the client keeps of a bot's desktop: its driver connection, and the references of its latest snapshot. */
type BotDesktop = { socket: string; client?: Promise<McpClient>; refs: Map<string, RefTarget>; nextRef: number }

type Data = Record<string, unknown>
export type Answer = { data: Data; text: string; image?: Uint8Array; isError: boolean }

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** A tool result's fields: its structured content, else its text read as JSON. */
export function readToolResult(result: McpToolResult): Answer {
  const text = result.content.flatMap((part) => (part.type === 'text' && 'text' in part ? [part.text] : [])).join('\n')
  let data = result.structuredContent
  if (!data) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') data = parsed as Data
    } catch {
      // Plain text.
    }
  }
  const image = result.content.find((part) => part.type === 'image' && 'data' in part)
  return {
    data: data ?? {},
    text,
    ...(image && 'data' in image && { image: Uint8Array.from(Buffer.from(image.data, 'base64')) }),
    isError: result.isError ?? false,
  }
}

/** Why the driver refused, when it did. */
const refusalCode = ({ data }: Answer) => str((data.refusal as Data | undefined)?.code) ?? str(data.code)

/**
 * The driver's hint of what to do next, unless it names the driver's own tools and fields, which the model doesn't have
 * (e.g. "send the next ones as one run_steps call").
 */
function hintOf({ data }: Answer): string | undefined {
  const hint = str(data.hint) ?? str(data.suggestion)
  return hint && !/\b[a-z]+_[a-z_]+\b/.test(hint) ? hint : undefined
}

/** An action's effect as cua-driver reported it: its own effect, or refused when it delivered nothing. */
export function effectOf(answer: Answer, ref?: string): DesktopActionResult {
  const { data } = answer
  const hint = hintOf(answer)
  const effect = data.effect as DesktopEffect | undefined
  if (effect && desktopEffects.includes(effect)) {
    const summary = str(data.summary) ?? answer.text
    return { effect, summary: effect !== 'confirmed' && hint ? `${summary} ${hint}` : summary }
  }
  const code = refusalCode(answer)
  if (code === 'stale_element_token' && ref) {
    return { effect: 'refused', summary: `${ref} isn't on the latest snapshot of its window any more; take a new snapshot and use its references` }
  }
  if (code === 'screenshot_context_missing') {
    return { effect: 'refused', summary: 'Refused: there is no current screenshot of this window to measure the point on; take a new snapshot or screenshot of it and use a point from that' }
  }
  if (code || data.status === 'refused' || answer.isError) {
    const why = str((data.refusal as Data | undefined)?.message) ?? str(data.detail) ?? str(data.message) ?? str(data.error) ?? answer.text
    return { effect: 'refused', summary: [`Refused${code ? ` (${code})` : ''}: ${why}`, hint].filter(Boolean).join(' ') }
  }
  // An answer of another shape: delivered, as far as anyone can tell.
  return { effect: 'unverifiable', summary: str(data.summary) ?? answer.text }
}

const toWindow = (data: Data): DesktopWindow => {
  const bounds = (data.bounds ?? data.window_bounds ?? {}) as Data
  return {
    id: Number(data.window_id),
    app: String(data.app_name ?? ''),
    title: String(data.title ?? data.window_title ?? ''),
    x: Number(bounds.x ?? data.x ?? 0),
    y: Number(bounds.y ?? data.y ?? 0),
    width: Number(bounds.width ?? data.width ?? 0),
    height: Number(bounds.height ?? data.height ?? 0),
  }
}

/** Keys as cua-driver names them: `ctrl+s` becomes ["ctrl", "s"], `Return` becomes "return". */
export function parseKeys(keys: string): string[] {
  return keys
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => (key.length === 1 ? key : key.toLowerCase()))
}

/**
 * Each bot's desktop, driven through its screen's cua-driver (`cua-driver serve` on the screen, see
 * apps/desktopd/src/programs.ts) over MCP: one `cua-driver mcp --socket` client per bot, whose transport keeps the
 * driver's snapshots between calls. Snapshots render the driver's accessibility tree with references counting up per
 * bot (`[ref=d12]`), so a reference from an older snapshot is refused rather than landing on whatever now has its index.
 *
 * Input is first sent in the background, as the driver prefers. A screen's display (Xvfb) has no input device for
 * focus-free keys and pointer events, so when the driver refuses for that reason the action is sent again in the
 * foreground: it activates the window, which is fine on the bot's own screen.
 */
export function connectDesktop({ screens, runAs, ...options }: DesktopOptions): Desktop & { close(): Promise<void> } {
  const desktops = new Map<string, BotDesktop>()
  const asOther = runAs !== undefined && runAs !== userInfo().username
  // Cua's product telemetry is off (`env`, since sudo doesn't pass the image's environment on).
  const command = options.command ?? ((socket: string) => [
    ...(asOther ? ['sudo', '--non-interactive', '--set-home', `--user=${runAs}`, '--'] : []),
    'env',
    'CUA_DRIVER_RS_TELEMETRY_ENABLED=0',
    'cua-driver',
    'mcp',
    '--socket',
    socket,
  ])

  async function desktopOf(bot: ComputerBot): Promise<BotDesktop> {
    const status = await screens.status(bot)
    if (status.state !== 'running' || status.display === null) throw new DesktopUnavailableError(`${bot.name}'s screen isn't running (${status.state})`)
    const socket = desktopDriverSocket(status.display)
    const known = desktops.get(bot.id)
    if (known?.socket === socket) return known
    void known?.client?.then((client) => client.close(), () => {})
    const fresh: BotDesktop = { socket, refs: new Map(), nextRef: 1 }
    desktops.set(bot.id, fresh)
    return fresh
  }

  function client(bot: ComputerBot, desktop: BotDesktop): Promise<McpClient> {
    const current = desktop.client
    if (current) {
      return current.then((connected) => {
        if (!connected.closed) return connected
        if (desktop.client === current) desktop.client = undefined
        return client(bot, desktop)
      })
    }
    const started = McpClient.start(command(desktop.socket)).catch((error: Error) => {
      if (desktop.client === started) desktop.client = undefined
      throw new DesktopUnavailableError(`${bot.name}'s desktop can't be reached: ${error.message}`)
    })
    desktop.client = started
    return started
  }

  /**
   * Calls one of the driver's tools. When the driver went away under the client (its screen's cua-driver restarted), a
   * read is sent again on a new client; an action isn't, since it may have landed before the driver went, so it comes
   * back as `undefined` for the caller to report as unverified. The driver's snapshots are gone either way.
   */
  async function call(bot: ComputerBot, tool: string, args: Data, read = true): Promise<Answer> {
    const desktop = await desktopOf(bot)
    const connected = await client(bot, desktop)
    try {
      return readToolResult(await connected.callTool(tool, args))
    } catch (error) {
      if (!connected.closed) throw error
      desktop.refs.clear()
      if (!read) throw new DriverGone(`The screen's driver went away during ${tool}`)
      return readToolResult(await (await client(bot, desktop)).callTool(tool, args))
    }
  }

  async function listWindows(bot: ComputerBot, filter: Data = {}): Promise<(DesktopWindow & { pid: number })[]> {
    const answer = await call(bot, 'list_windows', filter)
    if (answer.isError) throw new Error(answer.text)
    const windows = (answer.data.windows ?? []) as Data[]
    return windows.filter((window) => window.window_id !== undefined).map((window) => ({ ...toWindow(window), pid: Number(window.pid) }))
  }

  /** The driver's target for a window: its process and id; undefined when the screen has no such window. */
  async function findWindow(bot: ComputerBot, id: number) {
    const window = (await listWindows(bot)).find((each) => each.id === id)
    return window && { kind: 'window', pid: window.pid, window_id: id }
  }
  const noWindow = (bot: ComputerBot, id: number) => `There's no window ${id} on ${bot.name}'s screen; list the windows again`
  async function windowTarget(bot: ComputerBot, id: number) {
    const target = await findWindow(bot, id)
    if (!target) throw new Error(noWindow(bot, id))
    return target
  }

  /** The driver's arguments for an element of the latest snapshot, or undefined when it isn't on it. */
  async function elementArgs(bot: ComputerBot, ref: string): Promise<Data | undefined> {
    const target = (await desktopOf(bot)).refs.get(ref)
    return target && { target: { kind: 'window', pid: target.pid, window_id: target.window }, element_token: target.token }
  }

  const stale = (ref: string): DesktopActionResult => ({
    effect: 'refused',
    summary: `${ref} isn't on the latest snapshot; take a new snapshot and use its references`,
  })

  /**
   * Sends an action in the background, then in the foreground when the screen can't take it in the background. The
   * driver's summary names elements by its own index (`element [17]`); they are named by reference instead.
   */
  async function act(bot: ComputerBot, tool: string, args: Data, ref?: string): Promise<DesktopActionResult> {
    let answer: Answer
    try {
      answer = await call(bot, tool, args, false)
      if (refusalCode(answer) === 'background_unavailable') answer = await call(bot, tool, { ...args, delivery_mode: 'foreground' }, false)
    } catch (error) {
      if (!(error instanceof DriverGone)) throw error
      return { effect: 'unverifiable', summary: "The screen's driver restarted during the action, so it may or may not have landed; take a new snapshot before doing it again" }
    }
    const result = effectOf(answer, ref)
    const target = ref && (await desktopOf(bot)).refs.get(ref)
    if (!target) return result
    const index = target.token.slice(target.token.indexOf(':') + 1)
    return { ...result, summary: result.summary.replaceAll(`element [${index}]`, ref) }
  }

  async function targetArgs(bot: ComputerBot, at: DesktopElement | DesktopWindowTarget | DesktopPoint): Promise<Data | DesktopActionResult> {
    if ('ref' in at) return (await elementArgs(bot, at.ref)) ?? stale(at.ref)
    const window = await findWindow(bot, at.window)
    if (!window) return { effect: 'refused', summary: noWindow(bot, at.window) }
    return 'x' in at ? { target: window, x: at.x, y: at.y } : { target: window }
  }
  const isResult = (value: Data | DesktopActionResult): value is DesktopActionResult => 'effect' in value && 'summary' in value

  function image(answer: Answer, what: string): Uint8Array {
    if (!answer.image) throw new Error(`No screenshot of ${what}: ${effectOf(answer).summary}`)
    return answer.image
  }

  return {
    async windows(bot) {
      return (await listWindows(bot)).map(({ pid: _, ...window }) => window)
    },

    async open(bot, app) {
      const before = new Set((await listWindows(bot)).map((window) => window.id))
      const answer = await call(bot, 'launch_app', { name: app }, false).catch((error: Error) => {
        throw error instanceof DriverGone ? new Error(`${error.message}, so ${app} may or may not have started; list the windows to see`) : error
      })
      if (answer.isError || answer.data.pid === undefined) throw new Error(`Couldn't open ${app}: ${effectOf(answer).summary}`)
      const pid = Number(answer.data.pid)
      // A window can take a moment to show; an app that hands off to a running instance shows it under that one's pid.
      const deadline = Date.now() + openTimeoutMs
      for (;;) {
        const windows = (await listWindows(bot)).filter((window) => window.pid === pid || !before.has(window.id))
        if (windows.length || Date.now() > deadline) return windows.map(({ pid: _, ...window }) => window)
        await sleep(200)
      }
    },

    async snapshot(bot, windowId) {
      const target = await windowTarget(bot, windowId)
      // With its screenshot, which the driver keeps as the frame of point targets; the image itself isn't passed on.
      const answer = await call(bot, 'get_window_state', { pid: target.pid, window_id: windowId })
      const markdown = str(answer.data.tree_markdown)
      const snapshotId = str(answer.data.snapshot_id)
      if (answer.isError || markdown === undefined || !snapshotId) throw new Error(`Couldn't read window ${windowId}: ${effectOf(answer).summary}`)
      const desktop = await desktopOf(bot)
      desktop.refs = new Map()
      const lines = markdown.replace(/\n$/, '').split('\n').map((line) =>
        line.replace(/^(\s*- )\[(\d+)\] /, (_match, indent: string, index: string) => {
          const ref = `d${desktop.nextRef++}`
          desktop.refs.set(ref, { token: `${snapshotId}:${index}`, pid: target.pid, window: windowId })
          return `${indent}[ref=${ref}] `
        }),
      )
      if (answer.data.truncated === true) {
        lines.push(`(The tree was cut at ${answer.data.returned_element_count ?? 'some'} of ${answer.data.total_element_count ?? 'more'} elements.)`)
      }
      if (answer.data.degraded === true) lines.push(`(The tree may be incomplete: ${str(answer.data.degraded_reason) ?? 'the app shows little of it'}.)`)
      return { window: toWindow({ ...answer.data, window_id: windowId }), tree: lines.join('\n') }
    },

    async click(bot, at, options) {
      const args = await targetArgs(bot, at)
      if (isResult(args)) return args
      return act(bot, 'click', { ...args, button: options?.button ?? 'left', count: options?.count ?? 1 }, 'ref' in at ? at.ref : undefined)
    },

    async type(bot, into, text) {
      const args = await targetArgs(bot, into)
      if (isResult(args)) return args
      if ('ref' in into) return act(bot, 'type_text', { ...args, text }, into.ref)
      // Into what has focus: as real keys, which replace a selection, where the background route inserts text through
      // accessibility at the caret and leaves the selection be.
      return act(bot, 'type_text', { ...args, text, delivery_mode: 'foreground' })
    },

    async press(bot, windowId, keys) {
      const window = await findWindow(bot, windowId)
      if (!window) return { effect: 'refused', summary: noWindow(bot, windowId) }
      const target = { target: window }
      const parsed = parseKeys(keys)
      if (!parsed.length) return { effect: 'refused', summary: 'Say which key to press, e.g. "Return" or "ctrl+s"' }
      return parsed.length === 1 ? act(bot, 'press_key', { ...target, key: parsed[0] }) : act(bot, 'hotkey', { ...target, keys: parsed })
    },

    async scroll(bot, at, direction, amount) {
      const args = await targetArgs(bot, at)
      if (isResult(args)) return args
      return act(bot, 'scroll', { ...args, direction, amount: amount ?? 3 }, 'ref' in at ? at.ref : undefined)
    },

    async screenshot(bot, windowId) {
      if (windowId === undefined) return image(await call(bot, 'get_desktop_state', {}), `${bot.name}'s screen`)
      const target = await windowTarget(bot, windowId)
      return image(
        await call(bot, 'get_window_state', { pid: target.pid, window_id: windowId, include_accessibility_tree: false }),
        `window ${windowId}`,
      )
    },

    async close() {
      const clients = [...desktops.values()].map((desktop) => desktop.client)
      desktops.clear()
      await Promise.all(clients.map((client) => client?.then((connected) => connected.close(), () => {})))
    },
  }
}
