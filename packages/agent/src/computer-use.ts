import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { type ImageContent, type TextContent, Type } from '@earendil-works/pi-ai'
import {
  configure,
  type ConversationId,
  defineExtension,
  defineTool,
  type Extension,
  type ModelRef,
  section,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from '@earendil-works/pi-durable/tools'
import type { Browser, BrowserSnapshot, BotWithChat } from '@openbot/core'
import type { BotComputer } from './computer.ts'

const context = BACKGROUND_CONTEXT

/** How long a computer-use session may run before it is stopped, so a stuck one can't spend without end. */
const sessionTimeoutMs = 15 * 60_000

/** What the subagent is told, beyond whose browser it uses. */
const computerUseVoice = `You are a computer-use helper. You get one goal, reach it in a web browser, then answer with a short summary of what you did and what you found. That summary is all you hand back, so put the facts that were asked for in it: exact numbers, names, dates and URLs. Your text is never shown to the owner.

Work in small steps: observe, act, verify.
1. Observe: browser_snapshot shows the page as an accessibility tree, one element per line, with references like [ref=e12]. Read the page from the snapshot; never guess what it says.
2. Act on one element at a time by its reference: browser_click, or browser_type (submit presses Enter). browser_navigate opens a URL you know; browser_tabs lists, opens, selects and closes tabs. References only work until the next snapshot, and each action returns a new one.
3. Verify: check that the new snapshot shows what you expected before going on. Use browser_screenshot when how the page looks matters.

Never type passwords, card numbers or other secrets, and don't buy, send, post, delete or accept anything unless the goal says to. If a login, captcha or two-factor prompt blocks you, stop and start your summary with "Needs help:" and what the owner should do, so they can take over the screen.`

/** A snapshot as the model reads it. */
export function formatSnapshot({ url, title, tree }: BrowserSnapshot): string {
  return [`Page: ${title || '(untitled)'}`, `URL: ${url}`, '', tree || '(The page is empty.)'].join('\n')
}

const text = (value: string): TextContent => ({ type: 'text', text: value })

/** The latest snapshot after an action, so the model verifies what it did and gets fresh references. */
async function afterAction(browser: Browser, bot: BotWithChat, done: string) {
  return { output: [text(`${done}\n\n${formatSnapshot(await browser.snapshot(bot))}`)] }
}

export type ComputerUseOptions = {
  browser: Browser
  computer: BotComputer
  images: ImageProcessor
  /** The bot a conversation belongs to: its history, or a computer-use session it started. */
  botOf(conversationId: ConversationId): Promise<BotWithChat>
  /** The model computer-use sessions run on: the computer-use model, else the default. */
  model(): Promise<ModelRef>
}

/**
 * The computer-use subagent: an extension with only the browser tools, which a bot's `use_computer` call runs in a
 * child conversation it owns, on the computer-use model.
 */
export function computerUse(options: ComputerUseOptions) {
  const { browser, images, botOf } = options

  /** A screenshot the model can see, shrunk to fit; undefined when it can't be shown. */
  async function image(bytes: Uint8Array): Promise<ImageContent | undefined> {
    const prepared = await images.prepare(new Uint8Array(bytes), 'image/png', DEFAULT_IMAGE_LIMITS)
    return prepared && { type: 'image', data: prepared.data, mimeType: prepared.mimeType }
  }

  // One at a time: they all act on the same browser.
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
      execute: async (_args, api) => {
        const shot = await image(await browser.screenshot(await botOf(api.conversationId)))
        return { output: shot ? [shot] : [text("The screenshot can't be shown.")] }
      },
    }),
  ]

  const extension: Extension = defineExtension({
    name: 'computer-use',
    sections: [section('computer-use', () => computerUseVoice, { tag: false })],
    tools: browserTools,
  })

  const useComputer = defineTool({
    name: 'use_computer',
    description:
      'Hand a goal to a computer-use helper that works in your own web browser, on your screen, and get back its summary ' +
      'and a final screenshot. Slow and costly: use it only when plugins and the shell (curl, scripts) can\'t do the job, ' +
      'e.g. pages that need JavaScript, signing in or clicking through. Its work stays off the chat.',
    parameters: Type.Object({
      goal: Type.String({ description: 'What to do and what to report back, self-contained: the helper sees nothing else' }),
      reason: Type.String({ description: "Why this needs the browser rather than plugins or the shell; logged for the owner" }),
      startUrl: Type.Optional(Type.String({ description: 'A URL to open first' })),
    }),
    // A rerun after a restart finds the same session and its input.
    replay: 'safe',
    // A bot has one browser: two sessions at once would fight over its tab and invalidate each other's references.
    executionMode: 'sequential',
    execute: async (args, api) => {
      const bot = await botOf(api.conversationId)
      const model = await options.model()
      const session = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]
        if (existing) return existing.id
        const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
        await configure(tx, created.id, {
          model,
          extensions: [extension],
          instructions: `You work in ${bot.name}'s browser, for ${bot.name}, one of the owner's bots.`,
        })
        return created.id
      }, context)
      await api.details({ conversationId: session }, context)

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
      const answerId = settled.status === 'done' ? settled.answer : undefined
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

      // The final screenshot is saved, not shown: images would flood the bot's history (ADR 0008), and its model may not
      // see them. It can read the file to look, or attach it to show the owner.
      let screenshot: string
      try {
        const path = await options.computer.writeFile(bot, `screenshots/computer-${Date.now()}.png`, await browser.screenshot(bot))
        screenshot = `The screen at the end is saved at ${path}; read it to look, or attach it with sendMessage to show the owner.`
      } catch (error) {
        screenshot = `No final screenshot: ${(error as Error).message}`
      }
      return { output: [text(`${summary}\n\n${screenshot}`)] }
    },
  })

  return { extension, useComputer, browserToolNames: browserTools.map((tool) => tool.name) }
}
