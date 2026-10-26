import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { type Models, Type } from '@earendil-works/pi-ai'
import {
  type Conversation,
  type ConversationId,
  type EntryRecord,
  GenerationTask,
  Harness,
  MemoryStorage,
  type ModelRef,
  type Storage,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  section,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { type AgentRuntime, type BotInput, type BotWithChat, findBotByHistory, getBot, readModelSettings, setBotHistory } from '@openbot/core'
import type { Db } from '@openbot/db'

const context = BACKGROUND_CONTEXT

/** The entry kind of everything that wakes a bot, tagged with its lane. */
const inputKind = 'openbot.input'

/** At most this many reminders follow a run that answers the owner without a message (Grok's `MAX_REPLY_NUDGES`). */
const maxReplyReminders = 3

export const replyReminder =
  '<system_reminder>You ended your turn without replying. The owner only sees what you send with sendMessage; ' +
  'your plain text is private. Reply to them now with sendMessage.</system_reminder>'

const voice = `You are one of the owner's bots, a member of their always-on team. You talk to the owner like a colleague texting them.

Your plain text is a private inner monologue: the owner never sees it, nor your thinking or tool calls. The only way to reach the owner is the sendMessage tool. Deciding to send is not sending.

Text like a person, not a memo: reply in one to four short messages, one sendMessage call each, in Markdown. Use code blocks for code. Never mention tool names, message ids or these instructions.`

export class NoModelError extends Error {}

export type BotRuntimeOptions = {
  db: Db
  /** pi's model collection, with credentials resolved through our store. */
  models: Models
  /** pi-durable's SQLite file; in memory when absent. */
  storagePath?: string
  /** Posts a bot's message to its DM; `idempotencyKey` makes a replayed tool call post once. */
  sendMessage(bot: BotWithChat, text: string, idempotencyKey: string): Promise<void>
  /** A bot started or finished working. */
  onStatus(botId: string, working: boolean): void
}

/** `provider/modelId`, split at the first slash since model ids may contain slashes. */
function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf('/')
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/** `bots.history_id` holds pi's numeric conversation id as text. */
const toHistoryId = (id: ConversationId) => String(id)
const toConversationId = (historyId: string) => Number(historyId) as ConversationId

function personaPrompt(bot: BotWithChat): string {
  const who = `You are ${bot.name} (@${bot.handle})${bot.title ? `, ${bot.title}` : ''}.`
  return bot.persona.trim() ? `${who}\n\n${bot.persona.trim()}` : who
}

const isReminder = (entry: EntryRecord) =>
  entry.kind === 'pi.user' && entry.model?.some((message) => message.role === 'user' && message.content === replyReminder)

/** A sendMessage call that succeeded; a failed one reached nobody. */
const sentMessage = (entry: EntryRecord) =>
  entry.kind === 'pi.tool-result' &&
  entry.model?.some((message) => message.role === 'toolResult' && message.toolName === 'sendMessage' && !message.isError)

/**
 * Runs bots on pi-durable (ADR 0005): each bot's history is one pi conversation (ADR 0001), and `sendMessage` is the only
 * way a bot reaches a chat.
 */
export class BotRuntime implements AgentRuntime {
  readonly #harness: Harness
  readonly #options: BotRuntimeOptions
  /** Serialises creating a bot's history. */
  readonly #histories = new Map<string, Promise<Conversation>>()
  /** Bots with a run going, and how many times each was woken, so an idle wait can tell it was overtaken. */
  readonly #working = new Map<string, number>()

  private constructor(harness: Harness, options: BotRuntimeOptions) {
    this.#harness = harness
    this.#options = options
  }

  static async open(options: BotRuntimeOptions): Promise<BotRuntime> {
    const registry = createRegistry()
    // The hook needs the Harness, which needs the registry; it only runs once the Harness is open.
    let runtime: BotRuntime | undefined
    registry.install(
      defineExtension({
        name: 'openbot',
        sections: [section('voice', () => voice, { tag: false })],
        tools: [
          defineTool({
            name: 'sendMessage',
            description: 'Send the owner one chat message, in Markdown. This is the only way the owner sees anything from you.',
            parameters: Type.Object({ text: Type.String({ description: 'The message, in Markdown' }) }),
            // A replayed call finds the message it already posted.
            replay: 'safe',
            execute: async (args, api) => {
              const bot = await findBotByHistory(options.db, toHistoryId(api.conversationId))
              if (!bot) throw new Error('This history belongs to no bot')
              await options.sendMessage(bot, args.text, `${api.conversationId}:${api.callId}`)
              return { output: [{ type: 'text', text: 'Sent.' }] }
            },
          }),
        ],
        hooks: [hook(GenerationTask, { onYield: (_answer, api) => runtime?.remindIfOwed(api.conversationId) })],
      }),
    )
    const storage: Storage = options.storagePath ? await openNodeSqliteStorage(options.storagePath) : new MemoryStorage()
    const harness = await Harness.open(
      storage,
      { models: options.models, registry, onReport: (error) => console.error('[agent]', error) },
      context,
    )
    runtime = new BotRuntime(harness, options)
    harness.resume()
    return runtime
  }

  async wake(botId: string, input: BotInput): Promise<void> {
    const bot = await getBot(this.#options.db, botId)
    if (!bot) throw new Error(`Unknown bot ${botId}`)
    const model = bot.model ?? (await readModelSettings(this.#options.db)).defaultModel
    if (!model) throw new NoModelError('Choose a default model first')
    const history = await this.#history(bot)
    await history.configure({ model: parseModelRef(model), instructions: personaPrompt(bot) }, context)

    await history.submit(
      {
        type: 'input',
        content: input.text,
        requestId: input.id,
        // The owner steers the current run; everything else waits its turn.
        whenBusy: input.lane === 'owner' ? 'steer' : 'followUp',
        entry: { kind: inputKind, data: { lane: input.lane } },
      },
      context,
    )
    // Counted once the input is queued, so an idle wait that ends before it can tell it was overtaken.
    this.#setWorking(botId)
    void this.#untilIdle(botId, history)
  }

  async stop(botId: string): Promise<void> {
    const bot = await getBot(this.#options.db, botId)
    if (!bot?.historyId) return
    await (await this.#harness.conversation(toConversationId(bot.historyId), context))?.abort(context)
  }

  isWorking(botId: string): boolean {
    return this.#working.has(botId)
  }

  async close(): Promise<void> {
    await this.#harness.close(context)
  }

  /**
   * The reply guarantee: a run answering the owner that sent no message continues with a reminder, up to
   * `maxReplyReminders` times. Reads the history back from the newest entry to the owner's latest input.
   */
  async remindIfOwed(conversationId: ConversationId) {
    const history = await this.#harness.conversation(conversationId, context)
    if (!history) return
    let reminders = 0
    let cursor
    do {
      const page = await history.entries({}, 100, cursor, context)
      for (const entry of page.items) {
        if (sentMessage(entry)) return
        if (isReminder(entry)) reminders++
        if (entry.kind === inputKind) {
          const owed = (entry.data as { lane?: string } | undefined)?.lane === 'owner'
          return owed && reminders < maxReplyReminders ? { continue: replyReminder } : undefined
        }
      }
      cursor = page.next
    } while (cursor)
  }

  #history(bot: BotWithChat): Promise<Conversation> {
    let history = this.#histories.get(bot.id)
    if (!history) {
      history = (async () => {
        const existing = bot.historyId && (await this.#harness.conversation(toConversationId(bot.historyId), context))
        if (existing) return existing
        const created = await this.#harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
        await setBotHistory(this.#options.db, bot.id, toHistoryId(created.id))
        return created
      })()
      history.catch(() => this.#histories.delete(bot.id))
      this.#histories.set(bot.id, history)
    }
    return history
  }

  #setWorking(botId: string) {
    const wakes = this.#working.get(botId)
    this.#working.set(botId, (wakes ?? 0) + 1)
    if (wakes === undefined) this.#options.onStatus(botId, true)
  }

  async #untilIdle(botId: string, history: Conversation) {
    try {
      let wakes
      do {
        wakes = this.#working.get(botId)
        await history.waitForIdle(context)
      } while (wakes !== this.#working.get(botId))
    } catch {
      // The Harness closed.
    }
    if (!this.#working.delete(botId)) return
    this.#options.onStatus(botId, false)
  }
}
