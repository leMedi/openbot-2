import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { type ImageContent, type TextContent, Type } from '@earendil-works/pi-ai'
import {
  configure,
  type ConversationId,
  type Cursor,
  defineExtension,
  type EntryId,
  defineTool,
  type Extension,
  type ModelRef,
  section,
  type ToolExecutionApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from '@earendil-works/pi-durable/tools'
import type {
  BotWithChat,
  Browser,
  BrowserSnapshot,
  Desktop,
  DesktopActionResult,
  DesktopElement,
  DesktopPoint,
  DesktopSnapshot,
  DesktopWindow,
  DesktopWindowTarget,
  TakeOverCard,
} from '@openbot/core'
import type { BotComputer } from './computer.ts'

const context = BACKGROUND_CONTEXT

/** How long a computer-use session may run before it is stopped, so a stuck one can't spend without end. */
const sessionTimeoutMs = 15 * 60_000

/** What the subagent is told, beyond whose screen it uses. */
const computerUseVoice = `You are a computer-use helper. You get one goal, reach it on a screen, in its web browser or its desktop apps, then answer with a short summary of what you did and what you found. That summary is all you hand back, so put the facts that were asked for in it: exact numbers, names, dates and URLs. Your text is never shown to the owner.

Work in small steps: observe, act, verify.

Web pages: use the browser tools.
1. Observe: browser_snapshot shows the page as an accessibility tree, one element per line, with references like [ref=e12]. Read the page from the snapshot; never guess what it says.
2. Act on one element at a time by its reference: browser_click, or browser_type (submit presses Enter). browser_navigate opens a URL you know; browser_tabs lists, opens, selects and closes tabs. References only work until the next snapshot, and each action returns a new one.
3. Verify: check that the new snapshot shows what you expected before going on. Use browser_screenshot when how the page looks matters.

Desktop apps (anything that isn't a web page; the browser is a desktop window too, but drive pages with the browser tools):
1. Observe: desktop_windows lists the windows on the screen; desktop_open opens an app by name or command (e.g. mousepad) and gives its windows. desktop_snapshot shows a window's accessibility tree, with references like [ref=d12]. Only the latest snapshot's references work.
2. Act by reference: desktop_click, desktop_type (into an element, or into what has focus in a window), desktop_scroll; desktop_key presses a key or combination in a window, e.g. "Return" or "ctrl+s". When an app shows no tree, look with desktop_screenshot of its window and act on a point of that screenshot (x, y in its pixels).
3. Verify: each desktop action reports its effect. "confirmed" means it was read back. "unverifiable" means it was sent but its effect couldn't be seen, "suspected_noop" that nothing seems to have changed, "partial" that only part of it landed: take a new snapshot (or screenshot) and check before going on, and never repeat such an action without looking first, or you may do it twice. "refused" means nothing was sent; its summary says why.

Never type passwords, card numbers or other secrets, and don't buy, send, post, delete or accept anything unless the goal says to. When something only the owner can do blocks you (a login, a captcha, a two-factor code, a payment), call needs_help with one line telling them what to do on the screen, e.g. "Sign in to shop.test"; that ends your work, and the owner takes over the screen.`

/** A snapshot as the model reads it. */
export function formatSnapshot({ url, title, tree }: BrowserSnapshot): string {
  return [`Page: ${title || '(untitled)'}`, `URL: ${url}`, '', tree || '(The page is empty.)'].join('\n')
}

const text = (value: string): TextContent => ({ type: 'text', text: value })

/** A desktop snapshot as the model reads it. */
export function formatDesktopSnapshot({ window, tree }: DesktopSnapshot): string {
  return [`Window ${window.id}: ${window.title || '(untitled)'} (${window.app})`, '', tree || '(The window shows no elements.)'].join('\n')
}

/** The screen's windows as the model reads them. */
export function formatWindows(windows: DesktopWindow[]): string {
  if (!windows.length) return 'No windows.'
  return windows.map((window) => `- ${window.id}: ${window.app} — ${window.title || '(untitled)'} (${window.width}×${window.height} at ${window.x},${window.y})`).join('\n')
}

/** A desktop action's effect as the model reads it. */
export const formatEffect = ({ effect, summary }: DesktopActionResult) => `Effect: ${effect}. ${summary}`

/** What a session's `needs_help` call leaves in its result's details, for `use_computer` to find. */
type NeedsHelpDetails = { needsHelp: string }

/** What `use_computer`'s result keeps in its details: its session and, when it got stuck, the take-over it asked for. */
export type UseComputerDetails = { conversationId: number; takeOver?: { instruction: string } }

/** The latest snapshot after an action, so the model verifies what it did and gets fresh references. */
async function afterAction(browser: Browser, bot: BotWithChat, done: string) {
  return { output: [text(`${done}\n\n${formatSnapshot(await browser.snapshot(bot))}`)] }
}

export type ComputerUseOptions = {
  browser: Browser
  desktop: Desktop
  computer: BotComputer
  images: ImageProcessor
  /** The bot a conversation belongs to: its history, or a computer-use session it started. */
  botOf(conversationId: ConversationId): Promise<BotWithChat>
  /** The model the bot's computer-use sessions run on: the computer-use model, else the bot's own model, else the default. */
  model(bot: BotWithChat): Promise<ModelRef>
  /** The instruction of the bot's take-over card still waiting for the owner, or null. */
  waitingTakeOver(bot: BotWithChat): Promise<string | null>
  /** Posts a take-over card to the bot's DM; `idempotencyKey` makes a replayed call post once. */
  requestTakeOver(bot: BotWithChat, card: TakeOverCard, idempotencyKey: string): Promise<void>
}

/**
 * The computer-use subagent: an extension with only the browser and desktop tools, which a bot's `use_computer` call
 * runs in a child conversation it owns, on the computer-use model.
 */
export function computerUse(options: ComputerUseOptions) {
  const { browser, desktop, images, botOf } = options

  /** A screenshot the model can see, shrunk to fit; undefined when it can't be shown. */
  async function image(bytes: Uint8Array): Promise<ImageContent | undefined> {
    const prepared = await images.prepare(new Uint8Array(bytes), 'image/png', DEFAULT_IMAGE_LIMITS)
    return prepared && { type: 'image', data: prepared.data, mimeType: prepared.mimeType }
  }

  /** Whether the session's model accepts images: one without vision still works from snapshots. */
  async function seesImages(api: ToolExecutionApi, ctx: Context): Promise<boolean> {
    const { model } = await api.agent(ctx)
    return !!model && !!api.models.getModel(model.provider, model.modelId)?.input.includes('image')
  }

  /** A screenshot tool's result: the image, or text saying why there is none. */
  async function screenshot(api: ToolExecutionApi, ctx: Context, take: () => Promise<Uint8Array>) {
    if (!(await seesImages(api, ctx))) {
      return { output: [text("Your model can't see images, so screenshots aren't shown; work from the snapshots.")] }
    }
    const shot = await image(await take())
    return { output: shot ? [shot] : [text("The screenshot can't be shown.")] }
  }

  // One at a time: they all act on the same screen.
  const sequential = { executionMode: 'sequential' } as const
  const ref = Type.String({ description: 'The element\'s reference from the latest snapshot, e.g. "e12"' })

  const browserTools: ToolRegistration<any, any>[] = [
    defineTool({
      name: 'browser_snapshot',
      description: "Look at the active tab: its URL, title and accessibility tree, with a reference for each element. Old references stop working.",
      parameters: Type.Object({}),
      ...sequential,
      execute: async (_args, api) => ({ output: [text(formatSnapshot(await browser.snapshot(await botOf(api.conversationId))))] }),
    }),
    defineTool({
      name: 'browser_navigate',
      description: 'Open a URL in the active tab and wait for it to load.',
      parameters: Type.Object({ url: Type.String({ description: 'An absolute URL, e.g. https://example.com/pricing' }) }),
      ...sequential,
      execute: async (args, api) => {
        const bot = await botOf(api.conversationId)
        await browser.navigate(bot, args.url)
        return afterAction(browser, bot, `Opened ${args.url}.`)
      },
    }),
    defineTool({
      name: 'browser_click',
      description: 'Click an element of the latest snapshot.',
      parameters: Type.Object({ ref }),
      ...sequential,
      execute: async (args, api) => {
        const bot = await botOf(api.conversationId)
        await browser.click(bot, args.ref)
        return afterAction(browser, bot, `Clicked ${args.ref}.`)
      },
    }),
    defineTool({
      name: 'browser_type',
      description: 'Replace the text of a field of the latest snapshot; submit presses Enter after.',
      parameters: Type.Object({
        ref,
        text: Type.String({ description: 'What the field should hold' }),
        submit: Type.Optional(Type.Boolean({ description: 'Press Enter after typing, e.g. to search' })),
      }),
      ...sequential,
      execute: async (args, api) => {
        const bot = await botOf(api.conversationId)
        await browser.type(bot, args.ref, args.text, { submit: args.submit ?? false })
        return afterAction(browser, bot, `Typed into ${args.ref}${args.submit ? ' and pressed Enter' : ''}.`)
      },
    }),
    defineTool({
      name: 'browser_tabs',
      description: 'List the tabs, open a new one (at a URL or blank), or select or close one by its id. The other tools act on the active tab.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('new'), Type.Literal('select'), Type.Literal('close')]),
        tabId: Type.Optional(Type.String({ description: 'The tab to select or close, from the list' })),
        url: Type.Optional(Type.String({ description: 'Where a new tab opens' })),
      }),
      ...sequential,
      execute: async (args, api) => {
        const bot = await botOf(api.conversationId)
        if (args.action === 'new') await browser.newTab(bot, args.url)
        if (args.action === 'select' || args.action === 'close') {
          if (!args.tabId) throw new Error(`Say which tab to ${args.action} with tabId`)
          await (args.action === 'select' ? browser.selectTab(bot, args.tabId) : browser.closeTab(bot, args.tabId))
        }
        const tabs = await browser.tabs(bot)
        const lines = tabs.map((tab) => `- ${tab.id}${tab.active ? ' (active)' : ''}: ${tab.title || '(untitled)'} — ${tab.url}`)
        const listed = `Tabs:\n${lines.join('\n')}`
        // A tab change shows the tab now active, with references to act on.
        return args.action === 'list' ? { output: [text(listed)] } : afterAction(browser, bot, listed)
      },
    }),
    defineTool({
      name: 'browser_screenshot',
      description: 'See the active tab as it looks on the screen.',
      parameters: Type.Object({}),
      ...sequential,
      execute: async (_args, api, ctx) => screenshot(api, ctx, async () => browser.screenshot(await botOf(api.conversationId))),
    }),
  ]

  const windowId = Type.Integer({ description: 'The window\'s id, from desktop_windows or desktop_open' })
  const desktopRef = Type.String({ description: 'The element\'s reference from the latest desktop snapshot, e.g. "d12"' })
  /** An element by reference, or a whole window. */
  function elementOrWindow(args: { ref?: string; windowId?: number }): DesktopElement | DesktopWindowTarget {
    if (args.ref) return { ref: args.ref }
    if (args.windowId === undefined) throw new Error('Say where: ref, or windowId')
    return { window: args.windowId }
  }
  /** An element by reference, or a point of a window's screenshot. */
  function elementOrPoint(args: { ref?: string; windowId?: number; x?: number; y?: number }): DesktopElement | DesktopPoint {
    if (args.ref) return { ref: args.ref }
    if (args.windowId === undefined || args.x === undefined || args.y === undefined) throw new Error('Say where: ref, or windowId with x and y')
    return { window: args.windowId, x: args.x, y: args.y }
  }
  const effect = (result: DesktopActionResult) => ({ output: [text(formatEffect(result))] })

  const desktopTools: ToolRegistration<any, any>[] = [
    defineTool({
      name: 'desktop_windows',
      description: 'List the windows on the screen: id, app, title, size and position.',
      parameters: Type.Object({}),
      ...sequential,
      execute: async (_args, api) => ({ output: [text(formatWindows(await desktop.windows(await botOf(api.conversationId))))] }),
    }),
    defineTool({
      name: 'desktop_open',
      description: 'Open a desktop app by name or command, e.g. mousepad, and get its windows once one shows.',
      parameters: Type.Object({ app: Type.String({ description: 'The app\'s name or command' }) }),
      ...sequential,
      execute: async (args, api) => {
        const windows = await desktop.open(await botOf(api.conversationId), args.app)
        return { output: [text(windows.length ? `Opened ${args.app}:\n${formatWindows(windows)}` : `Started ${args.app}, but no window has shown yet; list the windows in a moment.`)] }
      },
    }),
    defineTool({
      name: 'desktop_snapshot',
      description: 'Look at a window: its accessibility tree, with a reference for each element you can act on. Old references stop working.',
      parameters: Type.Object({ windowId }),
      ...sequential,
      execute: async (args, api) => ({ output: [text(formatDesktopSnapshot(await desktop.snapshot(await botOf(api.conversationId), args.windowId)))] }),
    }),
    defineTool({
      name: 'desktop_click',
      description: 'Click an element of the latest desktop snapshot, or a point of a window (x, y in pixels of its screenshot). Reports the effect.',
      parameters: Type.Object({
        ref: Type.Optional(desktopRef),
        windowId: Type.Optional(windowId),
        x: Type.Optional(Type.Integer({ description: 'Pixels from the left of the window\'s screenshot' })),
        y: Type.Optional(Type.Integer({ description: 'Pixels from the top of the window\'s screenshot' })),
        button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right')])),
        double: Type.Optional(Type.Boolean({ description: 'Double-click' })),
      }),
      ...sequential,
      execute: async (args, api) =>
        effect(await desktop.click(await botOf(api.conversationId), elementOrPoint(args), { button: args.button ?? 'left', count: args.double ? 2 : 1 })),
    }),
    defineTool({
      name: 'desktop_type',
      description: 'Type text into an element of the latest desktop snapshot, or into what has focus in a window. Reports the effect.',
      parameters: Type.Object({ ref: Type.Optional(desktopRef), windowId: Type.Optional(windowId), text: Type.String() }),
      ...sequential,
      execute: async (args, api) => effect(await desktop.type(await botOf(api.conversationId), elementOrWindow(args), args.text)),
    }),
    defineTool({
      name: 'desktop_key',
      description: 'Press a key or a combination in a window, e.g. "Return", "Escape", "ctrl+s" or "ctrl+shift+t". Reports the effect.',
      parameters: Type.Object({ windowId, keys: Type.String({ description: 'Keys joined by +' }) }),
      ...sequential,
      execute: async (args, api) => effect(await desktop.press(await botOf(api.conversationId), args.windowId, args.keys)),
    }),
    defineTool({
      name: 'desktop_scroll',
      description: 'Scroll an element of the latest desktop snapshot, or a window. Reports the effect.',
      parameters: Type.Object({
        ref: Type.Optional(desktopRef),
        windowId: Type.Optional(windowId),
        direction: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')]),
        amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'Steps; 3 when left out' })),
      }),
      ...sequential,
      execute: async (args, api) => effect(await desktop.scroll(await botOf(api.conversationId), elementOrWindow(args), args.direction, args.amount)),
    }),
    defineTool({
      name: 'desktop_screenshot',
      description: 'See a window, or the whole screen without windowId. Points for desktop_click are pixels of a window\'s screenshot.',
      parameters: Type.Object({ windowId: Type.Optional(windowId) }),
      ...sequential,
      execute: async (args, api, ctx) => screenshot(api, ctx, async () => desktop.screenshot(await botOf(api.conversationId), args.windowId)),
    }),
  ]

  const needsHelp = defineTool({
    name: 'needs_help',
    description:
      'Stop and ask the owner to take over the screen, for what only they can do: a login, a captcha, a two-factor code, ' +
      'a payment. Ends your work.',
    parameters: Type.Object({
      instruction: Type.String({ description: 'One line telling the owner what to do on the screen, e.g. "Sign in to shop.test"' }),
    }),
    execute: async (args) => ({
      output: [text('The owner is asked to take over the screen. Stop here.')],
      details: { needsHelp: args.instruction.trim() || 'Help on the screen' } satisfies NeedsHelpDetails,
      control: { terminate: true },
    }),
  })

  const tools = [...browserTools, ...desktopTools, needsHelp]
  const extension: Extension = defineExtension({
    name: 'computer-use',
    sections: [section('computer-use', () => computerUseVoice, { tag: false })],
    tools,
  })

  const useComputer = defineTool({
    name: 'use_computer',
    description:
      'Hand a goal to a computer-use helper that works on your screen, in your own web browser or desktop apps, and get ' +
      'back its summary and a final screenshot. Slow and costly: use it only when plugins and the shell (curl, scripts) ' +
      'can\'t do the job, e.g. pages that need JavaScript, signing in or clicking through, or an app with no command line. ' +
      'Its work stays off the chat.',
    parameters: Type.Object({
      goal: Type.String({ description: 'What to do and what to report back, self-contained: the helper sees nothing else' }),
      reason: Type.String({ description: "Why this needs the screen rather than plugins or the shell; logged for the owner" }),
      startUrl: Type.Optional(Type.String({ description: 'A URL to open first' })),
    }),
    // A rerun after a restart finds the same session and its input.
    replay: 'safe',
    // A bot has one screen: two sessions at once would fight over it and invalidate each other's references.
    executionMode: 'sequential',
    execute: async (args, api) => {
      const bot = await botOf(api.conversationId)
      // Checked once: a rerun after a restart may find the card this very call posted.
      const waiting = (await api.memo<boolean>('started', context)) ? null : await options.waitingTakeOver(bot)
      if (waiting) {
        throw new Error(
          `The owner hasn't handed your screen back yet; you asked them: "${waiting}". Wait: handing it back wakes you.`,
        )
      }
      await api.memo('started', true, context)
      const model = await options.model(bot)
      const session = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]
        if (existing) return existing.id
        const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
        await configure(tx, created.id, {
          model,
          extensions: [extension],
          instructions: `You work on ${bot.name}'s screen, for ${bot.name}, one of the owner's bots.`,
        })
        return created.id
      }, context)
      await api.details({ conversationId: session } satisfies UseComputerDetails, context)

      // Opened once: a rerun after a restart finds the session mid-way and leaves its page alone.
      let start = (await api.memo<string>('start', context)) ?? ''
      if (args.startUrl && !start) {
        try {
          await browser.navigate(bot, args.startUrl)
          start = `\n\nThe browser has opened ${args.startUrl}.`
        } catch (error) {
          start = `\n\nOpening ${args.startUrl} failed: ${(error as Error).message}`
        }
        await api.memo('start', start, context)
      }
      const handle = await api.conversation(session, context)
      if (!handle) throw new Error('The computer-use session is gone')
      const submission = await handle.submit({ type: 'input', content: `${args.goal}${start}`, requestId: `use_computer:${api.taskId}` }, context)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void handle.abort(context)
      }, sessionTimeoutMs)
      const settled = await submission.wait(context).finally(() => clearTimeout(timer))
      const instruction = await neededHelp(api, session, settled.entry)
      const answerId = settled.status === 'done' ? settled.answer : undefined
      if (instruction) {
        // Stuck on what only the owner can do: they're asked on a card, and this run ends until they hand the screen back.
        const card: TakeOverCard = { type: 'take_over', instruction, goal: args.goal }
        await options.requestTakeOver(bot, card, `${api.conversationId}:${api.callId}`)
        return {
          output: [
            text(
              `The helper is stuck and needs the owner: ${instruction}\n\n` +
                'A take-over card now asks them to do it on your screen. Your turn ends here; when they hand the screen back, ' +
                'that wakes you with what they did.',
            ),
          ],
          details: { conversationId: session, takeOver: { instruction } } satisfies UseComputerDetails,
          control: { terminate: true },
        }
      }
      if (answerId === undefined) {
        const why = timedOut ? `it ran for more than ${sessionTimeoutMs / 60_000} minutes` : (settled.reason ?? 'it gave no answer')
        throw new Error(`The computer-use session stopped before finishing: ${why}`)
      }
      const answer = await api.commit((tx) => tx.entry(answerId), context)
      const summary =
        answer?.model
          ?.flatMap((message) => (message.role === 'assistant' ? message.content : []))
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
          .trim() || 'The computer-use session ended without a summary.'

      // The final screenshot, of the whole screen as the owner sees it (else of the browser's tab), is saved, not shown: images would flood the bot's
      // history (ADR 0008), and its model may not see them. It can read the file to look, or attach it to show the owner.
      let screenshot: string
      try {
        const path = await options.computer.writeFile(bot, `screenshots/computer-${Date.now()}.png`, await desktop.screenshot(bot).catch(() => browser.screenshot(bot)))
        screenshot = `The screen at the end is saved at ${path}; read it to look, or attach it with sendMessage to show the owner.`
      } catch (error) {
        screenshot = `No final screenshot: ${(error as Error).message}`
      }
      return { output: [text(`${summary}\n\n${screenshot}`)] }
    },
  })

  return { extension, useComputer, sessionToolNames: tools.map((tool) => tool.name) }
}

/** The instruction of a `needs_help` call the session made after its input `from`, or undefined when it made none. */
async function neededHelp(api: ToolExecutionApi, session: ConversationId, from: EntryId | undefined): Promise<string | undefined> {
  if (from === undefined) return undefined
  // Newest first: needs_help ends the session, so its result is among the last entries.
  let cursor: Cursor | undefined
  do {
    const page = await api.commit((tx) => tx.scanEntries({ conversationId: session, minEntryId: from }, 200, cursor), context)
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role !== 'toolResult' || message.toolName !== 'needs_help' || message.isError) continue
        const details = message.details as NeedsHelpDetails | undefined
        if (details?.needsHelp) return details.needsHelp
      }
    }
    cursor = page.next
  } while (cursor)
  return undefined
}
