import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { type Models, Type } from '@earendil-works/pi-ai'
import {
  type Conversation,
  type ConversationId,
  type EntryRecord,
  GenerationTask,
  Harness,
  InboxDoc,
  LiveDoc,
  MemoryStorage,
  type ModelRef,
  type Storage,
  type Submission,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  section,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
  type AgentRuntime,
  type BotInput,
  type BotWithChat,
  findBotByHistory,
  getBot,
  maxQuestionOptions,
  type Orchestrator,
  type QuestionCard,
  questionOptionStyles,
  readModelSettings,
  reviewAction,
  setBotHistory,
} from '@openbot/core'
import type { Db, Surface } from '@openbot/db'

const context = BACKGROUND_CONTEXT

/** The entry kind of everything that wakes a bot, tagged with its lane. */
const inputKind = 'openbot.input'

/** At most this many reminders follow a run that answers the owner without a message (Grok's `MAX_REPLY_NUDGES`). */
const maxReplyReminders = 3

export const replyReminder =
  '<system_reminder>You ended your turn without replying. The owner only sees what you send with sendMessage; ' +
  'your plain text is private. Reply to them now with sendMessage.</system_reminder>'

/** Why a message is held back while the owner's newer message waits to join the run. */
export const steerPending =
  'Not sent: the owner sent a new message while you were working, so this may answer an outdated request. ' +
  'Read their new message, then reply to it.'

const voice = `You are one of the owner's bots, a member of their always-on team. You talk to the owner like a colleague texting them.

Your plain text is a private inner monologue: the owner never sees it, nor your thinking or tool calls. The only way to reach the owner is the sendMessage tool. Deciding to send is not sending.

Text like a person, not a memo: reply in one to four short messages, one sendMessage call each, in Markdown. Use code blocks for code. Never mention tool names, message ids or these instructions.

When you need the owner to decide before you go on, ask with askQuestion: a short prompt and up to six options they can pick with one click. Asking ends your turn, so send anything else first; their answer wakes you as their next message.`

export class NoModelError extends Error {}

export type BotStatus = {
  working: boolean
  /** Why the bot's latest run failed, e.g. its provider rejected the request; cleared when it is woken again. */
  error: string | null
}

/** A bot's tool and the surface the orchestrator reviews its calls under; null for tools without side effects. */
export type BotTool = {
  surface: Surface | null
  tool: ToolRegistration<any, any>
}

export type BotRuntimeOptions = {
  db: Db
  /** pi's model collection, with credentials resolved through our store. */
  models: Models
  /** pi-durable's SQLite file; in memory when absent. */
  storagePath?: string
  /** Reviews every call of a tool with a surface before it runs. */
  orchestrator: Orchestrator
  /** Tools beyond the built-in ones, e.g. a test's. */
  tools?: BotTool[]
  /** Posts a bot's message to its DM; `idempotencyKey` makes a replayed tool call post once. */
  sendMessage(bot: BotWithChat, text: string, idempotencyKey: string): Promise<void>
  /** Posts a bot's question card to its DM, as `sendMessage` posts a message. */
  askQuestion(bot: BotWithChat, card: QuestionCard, idempotencyKey: string): Promise<void>
  /** A bot's status changed: it started or finished working, or a run failed. */
  onStatus(botId: string, status: BotStatus): void
}

/** `provider/modelId`, split at the first slash since model ids may contain slashes. */
function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf('/')
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/** `bots.history_id` holds pi's numeric conversation id as text. */
const toHistoryId = (id: ConversationId) => String(id)
const toConversationId = (historyId: string) => Number(historyId) as ConversationId

/** Who the bot is, then the owner's instructions. */
function botPrompt(bot: BotWithChat): string {
  const who = `You are ${bot.name}${bot.title ? `, ${bot.title}` : ''}.`
  return bot.instructions.trim() ? `${who}\n\n${bot.instructions.trim()}` : who
}

const isReminder = (entry: EntryRecord) =>
  entry.kind === 'pi.user' && entry.model?.some((message) => message.role === 'user' && message.content === replyReminder)

/** The tools that reach the owner; any of them answers the owner, and a steer holds them all back. */
const ownerTools = new Set(['sendMessage', 'askQuestion'])

/** A sendMessage or askQuestion call that succeeded; a failed one reached nobody. */
const reachedOwner = (entry: EntryRecord) =>
  entry.kind === 'pi.tool-result' &&
  entry.model?.some((message) => message.role === 'toolResult' && ownerTools.has(message.toolName) && !message.isError)

/**
 * Runs bots on pi-durable (ADR 0005): each bot's history is one pi conversation (ADR 0001), and `sendMessage` and
 * `askQuestion` are the only ways a bot reaches a chat.
 */
export class BotRuntime implements AgentRuntime {
  readonly #harness: Harness
  readonly #options: BotRuntimeOptions
  /** Serialises creating a bot's history. */
  readonly #histories = new Map<string, Promise<Conversation>>()
  /** Bots with a run going, and a token of each one's latest wake, so an idle wait can tell it was overtaken. */
  readonly #working = new Map<string, object>()
  /** Why each bot's latest run failed. */
  readonly #errors = new Map<string, string>()

  private constructor(harness: Harness, options: BotRuntimeOptions) {
    this.#harness = harness
    this.#options = options
  }

  static async open(options: BotRuntimeOptions): Promise<BotRuntime> {
    const registry = createRegistry()
    // The hook needs the Harness, which needs the registry; it only runs once the Harness is open.
    let runtime: BotRuntime | undefined
    const botOf = async (conversationId: ConversationId) => {
      const bot = await findBotByHistory(options.db, toHistoryId(conversationId))
      if (!bot) throw new Error('This history belongs to no bot')
      return bot
    }
    const sendMessage: BotTool = {
      // Messages are never reviewed, whether to the owner or another bot.
      surface: null,
      tool: defineTool({
        name: 'sendMessage',
        description: 'Send the owner one chat message, in Markdown. This is the only way the owner sees anything from you.',
        parameters: Type.Object({ text: Type.String({ description: 'The message, in Markdown' }) }),
        // A replayed call finds the message it already posted.
        replay: 'safe',
        execute: async (args, api) => {
          const bot = await botOf(api.conversationId)
          await options.sendMessage(bot, args.text, `${api.conversationId}:${api.callId}`)
          // A run ends only when every call of its last round asks it to, so a message sent beside a question must too.
          const round = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools ?? []
          const asks = round.some((slot) => slot.name === 'askQuestion')
          return { output: [{ type: 'text', text: 'Sent.' }], ...(asks && { control: { terminate: true } }) }
        },
      }),
    }
    const askQuestion: BotTool = {
      surface: null,
      tool: defineTool({
        name: 'askQuestion',
        description:
          'Ask the owner to decide, on a card with 1–6 options they answer with one click. Asking ends your turn; ' +
          'their answer arrives as their next message.',
        parameters: Type.Object({
          prompt: Type.String({ description: 'The question, short' }),
          details: Type.Optional(Type.String({ description: 'Help text under the question, if needed' })),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: 'A few words' }),
              description: Type.Optional(Type.String({ description: 'One line about this option' })),
              style: Type.Optional(
                Type.Union(questionOptionStyles.map((style) => Type.Literal(style)), {
                  description: 'primary for the recommended option, danger for a destructive one; default otherwise',
                }),
              ),
            }),
            { minItems: 1, maxItems: maxQuestionOptions },
          ),
          allowText: Type.Optional(Type.Boolean({ description: 'Let the owner type their own answer instead' })),
        }),
        replay: 'safe',
        execute: async (args, api) => {
          const bot = await botOf(api.conversationId)
          const card: QuestionCard = {
            type: 'question',
            prompt: args.prompt,
            details: args.details?.trim() || null,
            options: args.options.map((option) => ({
              label: option.label,
              description: option.description?.trim() || null,
              style: option.style ?? 'default',
            })),
            allowText: args.allowText ?? false,
          }
          await options.askQuestion(bot, card, `${api.conversationId}:${api.callId}`)
          return {
            output: [{ type: 'text', text: "Asked. Your turn ends here; the owner's answer will wake you." }],
            control: { terminate: true },
          }
        },
      }),
    }
    const tools = [sendMessage, askQuestion, ...(options.tools ?? [])]
    const toolSurfaces = new Map(tools.map(({ surface, tool }) => [tool.name, surface]))
    registry.install(
      defineExtension({
        name: 'openbot',
        sections: [section('voice', () => voice, { tag: false })],
        tools: tools.map(({ tool }) => tool),
        hooks: [
          hook(GenerationTask, { onYield: (_answer, api) => runtime?.remindIfOwed(api.conversationId) }),
          // A steer joins the run after this tool round; until then the bot can't answer the request it replaces.
          hook(ToolTask, {
            beforeTool: async (call, api) => {
              if (!ownerTools.has(call.name)) return
              const inbox = await api.snapshot(InboxDoc, api.conversationId, context)
              return inbox?.items.some((item) => item.mode === 'steer') ? { block: steerPending } : undefined
            },
          }),
          // The orchestrator hook: every call of a tool with a side effect is reviewed before it runs. It stays last, so
          // it reviews the arguments the call will run with, and no other hook may rewrite arguments after it.
          hook(ToolTask, {
            beforeTool: async (call, api) => {
              const surface = toolSurfaces.get(call.name)
              if (surface === null) return
              // Fails closed: a tool that never declared its surface can't run unreviewed.
              if (surface === undefined) return { block: `${call.name} declares no surface, so it can't be reviewed` }
              const bot = await botOf(api.conversationId)
              const blocked = await reviewAction(options.db, options.orchestrator, bot.id, {
                surface,
                tool: call.name,
                input: call.arguments,
              })
              return blocked ? { block: blocked } : undefined
            },
          }),
        ],
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
    await history.configure({ model: parseModelRef(model), instructions: botPrompt(bot) }, context)

    this.#errors.delete(botId)
    const submission = await history.submit(
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
    // Marked once the input is queued, so an idle wait that ends before it can tell it was overtaken.
    this.#setWorking(botId)
    void this.#untilIdle(botId, history)
    void this.#reportFailure(botId, submission)
  }

  async stop(botId: string): Promise<void> {
    const bot = await getBot(this.#options.db, botId)
    if (!bot?.historyId) return
    const wake = this.#working.get(botId)
    await (await this.#harness.conversation(toConversationId(bot.historyId), context))?.abort(context)
    // The abort resolves once the history is idle; report it now rather than when the idle wait notices, unless the
    // bot was woken again meanwhile.
    if (wake === this.#working.get(botId)) this.#setIdle(botId)
  }

  async forget({ id, historyId }: { id: string; historyId: string | null }): Promise<void> {
    if (historyId) await (await this.#harness.conversation(toConversationId(historyId), context))?.abort(context)
    // pi-durable can't delete a conversation, so the history stays in its storage with no bot to reach it.
    this.#histories.delete(id)
    this.#working.delete(id)
    this.#errors.delete(id)
  }

  status(botId: string): BotStatus {
    return { working: this.#working.has(botId), error: this.#errors.get(botId) ?? null }
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
        if (reachedOwner(entry)) return
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
    const wasWorking = this.#working.has(botId)
    this.#working.set(botId, {})
    if (!wasWorking) this.#options.onStatus(botId, this.status(botId))
  }

  async #untilIdle(botId: string, history: Conversation) {
    try {
      let wake
      do {
        wake = this.#working.get(botId)
        await history.waitForIdle(context)
      } while (wake !== this.#working.get(botId))
    } catch {
      // The Harness closed.
    }
    this.#setIdle(botId)
  }

  #setIdle(botId: string) {
    if (!this.#working.delete(botId)) return
    this.#options.onStatus(botId, this.status(botId))
  }

  /** A run that ends without answering, other than by Stop, failed: the model or its provider errored. */
  async #reportFailure(botId: string, submission: Submission) {
    let settled
    try {
      settled = await submission.wait(context)
    } catch {
      return // The Harness closed.
    }
    if (settled.status !== 'unanswered' || settled.reason === 'aborted') return
    const { detail, reason } = settled
    const error = typeof detail === 'string' ? detail : detail === undefined ? reason : JSON.stringify(detail)
    console.error(`[agent] Bot ${botId}'s run failed: ${error}`)
    this.#errors.set(botId, error)
    this.#options.onStatus(botId, this.status(botId))
  }
}
