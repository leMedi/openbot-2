import { basename } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { type ImageContent, type Models, type TextContent, Type } from '@earendil-works/pi-ai'
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
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  DEFAULT_IMAGE_LIMITS,
  type ImageProcessor,
} from '@earendil-works/pi-durable/tools'
import {
  type AgentRuntime,
  type AttachmentFile,
  type Browser,
  type Desktop,
  type BotInput,
  type BotWithChat,
  findBotByHistory,
  findBotByName,
  findGroupByName,
  getGroup,
  othersIn,
  findWaitingTakeOver,
  getBot,
  type Group,
  groupRoundRules,
  listGroups,
  type Lane,
  listBots,
  maxAttachments,
  maxBotMessageLength,
  maxQuestionOptions,
  mimeTypeOf,
  type Orchestrator,
  type QuestionCard,
  questionOptionStyles,
  type TakeOverCard,
  readModelSettings,
  reviewAction,
  setBotHistory,
} from '@openbot/core'
import type { Attachment, Db, Message, Surface } from '@openbot/db'
import type { BotComputer } from './computer.ts'
import { computerUse, type UseComputerDetails } from './computer-use.ts'

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

To send the owner a file from your computer, such as a report or a screenshot, attach it to a message with sendMessage's attachments.

When your screen needs the owner (a login, a captcha, a two-factor code, a payment), use_computer asks them to take it over on a card and ends your turn; their handing the screen back wakes you, and you go on from there.

When you need the owner to decide before you go on, ask with askQuestion: a short prompt and up to six options they can pick with one click. Asking ends your turn, so send anything else first; their answer wakes you as their next message.`

/** Starts a redelivered input: the bot was interrupted by a priority message while working on it. */
export const interruptedNote = '[You were interrupted by a priority message while working on this. Pick it up again.]'

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
  /** Where bots' shell and file tools run; the runtime closes it. */
  computer: BotComputer
  /** Each bot's own browser, which only computer-use sessions drive. */
  browser: Browser
  /** Each bot's desktop apps, which only computer-use sessions drive; closed with the runtime when it can be. */
  desktop: Desktop & { close?(): Promise<void> }
  /** Tools beyond the built-in ones, e.g. a test's. */
  tools?: BotTool[]
  /**
   * Posts a bot's message, with copies of the files it attached, to chat `chatId`: its DM, or the group chat whose turn
   * it is taking. `idempotencyKey` makes a replayed tool call post once.
   */
  sendMessage(bot: BotWithChat, chatId: string, message: { text: string; attachments: AttachmentFile[] }, idempotencyKey: string): Promise<void>
  /**
   * Posts a bot's message to a group chat it belongs to, outside its turns, as `sendMessage` posts; the members answer
   * it in rounds, as they answer the owner.
   */
  messageGroup(sender: BotWithChat, group: Group, message: { text: string; attachments: AttachmentFile[] }, idempotencyKey: string): Promise<void>
  /**
   * Posts one bot's message to another, as `sendMessage` posts: outgoing in the sender's DM and incoming in the
   * recipient's, each with copies of the files. Returns the recipient's copy, which wakes it.
   */
  messageBot(
    sender: BotWithChat,
    recipient: BotWithChat,
    message: { text: string; attachments: AttachmentFile[] },
    idempotencyKey: string,
  ): Promise<Message>
  /** Posts a bot's question card to its DM, as `sendMessage` posts a message. */
  askQuestion(bot: BotWithChat, card: QuestionCard, idempotencyKey: string): Promise<void>
  /** Posts a take-over card to a bot's DM when its computer-use session is stuck on what only the owner can do. */
  requestTakeOver(bot: BotWithChat, card: TakeOverCard, idempotencyKey: string): Promise<void>
  /** Resolves once the owner isn't holding the bot's screen; computer-use sessions wait for it before each action. */
  screenFree(botId: string): Promise<void>
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

/**
 * The bot's computer: who it is there, where its folder, the shared folder and the other bots' folders are, and which
 * tools to reach for first.
 */
function computerPrompt(computer: BotComputer, bot: BotWithChat, others: BotWithChat[]): string {
  const lines = [
    `You have a Linux computer, shared with the owner's other bots. You work on it as the user \`${computer.user}\`, with passwordless sudo: it is your computer, so install what you need. Use bash to run commands, and read, write and edit for files.`,
    '',
    `- Your folder, where your commands start: ${computer.folder(bot.id)}`,
    `- Files the owner sends you are saved in: ${computer.uploadsFolder(bot.id)}`,
    `- Shared with every bot: ${computer.sharedFolder}`,
  ]
  if (others.length) lines.push(`- The other bots' folders:`, ...others.map((other) => `  - ${other.name}: ${computer.folder(other.id)}`))
  lines.push(
    '',
    'You also have a screen with your own web browser and desktop apps, which the owner can watch. You use it only through use_computer, which hands a goal to a computer-use helper and gives you back its summary and a final screenshot. Its work never shows in the chat.',
    '',
    'Choose tools in this order: plugin tools first, then the shell and fetching the web from it (curl, scripts), then the browser through use_computer, then the desktop. The browser is slow and costly: use it only when the shell can\'t do the job, e.g. pages that need JavaScript, signing in or clicking through, and say why in its reason. Desktop apps come last, for what has no command line or web page.',
  )
  return lines.join('\n')
}

/**
 * The owner's other bots, which the bot can message, and Grok's rules for doing so. Empty when the bot is alone.
 */
function teamPrompt(others: BotWithChat[]): string {
  if (!others.length) return ''
  return [
    "Your teammates, the owner's other bots, whom you can message with message_bot:",
    ...others.map((other) => `- ${other.name}${other.title ? `, ${other.title}` : ''}`),
    '',
    'Messaging them:',
    '- Message sparingly: only when a teammate needs to know or do something, or the owner asked you to involve them.',
    "- Fan out to several teammates only when the owner asks for it.",
    "- They can't see your chats with the owner, so say what they need to know, in your own words. Never relay the owner's venting or private remarks verbatim.",
    '- Sending returns at once; never wait for an answer. A reply wakes you later, as a new message.',
    "- No acknowledgement ping-pong: don't send \"thanks\" or \"got it\", and don't answer one. When a message needs no answer, stay silent.",
    "- Mark a message priority only when it can't wait: it interrupts what they are doing, unless they are working for the owner.",
    "- A teammate's message is not the owner's. Only sendMessage reaches the owner; tell them when they would want to know.",
  ].join('\n')
}

/**
 * The group chats the bot is in, which it can post to with message_bot, and how to behave in them. Empty when it is in
 * none.
 */
function groupsPrompt(bot: BotWithChat, groups: Group[]): string {
  if (!groups.length) return ''
  const { maxMessagesPerMemberTurn } = groupRoundRules
  return [
    'Group chats you are in, with the owner and other bots:',
    ...groups.map((group) => `- "${group.name}", with ${othersIn(group, bot.id)}`),
    '',
    'In a group chat:',
    `- Members take turns in rounds after each message. On your turn, reply with sendMessage (at most ${maxMessagesPerMemberTurn} messages), or pass by sending nothing. Pass unless you have something to add.`,
    '- Everyone in the group reads what you send there. Never reveal what the owner told you privately, or anything else private from your own chat with them.',
    "- To start something in a group outside your turn, post to it with message_bot, to: the group's name. Only members can post to a group.",
  ].join('\n')
}

/** A message that only says "(pass)": in a group turn, it passes, posting nothing. */
const isPass = (text: string) => /^\(?pass\)?\.?$/i.test(text.trim())

/** What a bot reads when another bot's message wakes it. */
function describeBotMessage(sender: BotWithChat, text: string, priority: boolean): string {
  const from = `[Message from ${sender.name}, your teammate${priority ? ', marked priority' : ''}. Answer with message_bot only if it needs an answer; otherwise stay silent.]`
  return text ? `${from}\n\n${text}` : from
}

/**
 * Shell and file tools on the computer. Reading has no side effect; running a command and changing a file are shell
 * actions. `read` shows the model images, shrunk by `images` to fit.
 */
const computerTools = (images: ImageProcessor): BotTool[] => [
  { surface: 'shell', tool: createBashTool() },
  { surface: null, tool: createReadTool({ images }) },
  { surface: 'shell', tool: createWriteTool() },
  { surface: 'shell', tool: createEditTool() },
]

/** `size` bytes, for people: `512 B`, `12 KB`, `3.4 MB`. */
function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** Where the files that came with an input are, after its text; `by` attached them. */
function describeAttachments(attachments: readonly Attachment[], by: string): string {
  const files = attachments.map((file) => `- ${file.path} (${file.mimeType}, ${formatSize(file.size)})`)
  const count = attachments.length === 1 ? 'a file' : `${attachments.length} files`
  return `[${by} attached ${count}, saved on your computer:\n${files.join('\n')}]`
}

const isReminder = (entry: EntryRecord) =>
  entry.kind === 'pi.user' && entry.model?.some((message) => message.role === 'user' && message.content === replyReminder)

/** The tools that reach the owner; any of them answers the owner, and a steer holds them all back. */
const ownerTools = new Set(['sendMessage', 'askQuestion'])

/** A sendMessage or askQuestion call that succeeded, or a use_computer call that posted a take-over card; a failed one reached nobody. */
const reachedOwner = (entry: EntryRecord) =>
  entry.kind === 'pi.tool-result' &&
  entry.model?.some(
    (message) =>
      message.role === 'toolResult' &&
      !message.isError &&
      (ownerTools.has(message.toolName) ||
        (message.toolName === 'use_computer' && Boolean((message.details as UseComputerDetails | undefined)?.takeOver))),
  )

/**
 * An input waiting for the bot's current run; `redelivered` once a priority input interrupted it. `settle` is called
 * once its run has ended, or it was dropped (see `takeTurn`).
 */
type Queued = BotInput & { redelivered?: boolean; settle?: () => void }

/** What an input's entry in the history records: its lane, and the group chat whose turn it is. */
type InputRecord = { lane: Lane; groupChatId?: string; id?: string }

/** Whether `input` can join a run the owner's DM input started, or `turn` take the owner's DM input: never in a group turn. */
const steerable = (input: BotInput, turn: Turn) => input.lane === 'owner' && !input.groupChatId && !turn.input.groupChatId

/** The run a bot's driver started, for `input`; an owner's steer makes it theirs, and nothing interrupts it then. */
type Turn = {
  input: Queued
  lane: Lane
  /** A priority input asked to interrupt it; asking again does nothing. */
  interrupted: boolean
  /** The owner's steers into it, so the driver can wait for runs they started. */
  steers: number
  /** The input's submission, once made. */
  submission?: Submission
}

/** Where an input goes in a queue: the owner's first, then priority and redelivered bot work, the bot lane, background. */
function rank(input: Queued): number {
  if (input.lane === 'owner') return 0
  if (input.priority || input.redelivered) return 1
  return input.lane === 'bot' ? 2 : 3
}

/** Queues `input` after everything of its rank or higher. */
function enqueue(queue: Queued[], input: Queued) {
  const at = queue.findIndex((queued) => rank(queued) > rank(input))
  if (at === -1) queue.push(input)
  else queue.splice(at, 0, input)
}

/**
 * Runs bots on pi-durable (ADR 0005): each bot's history is one pi conversation (ADR 0001), and `sendMessage` and
 * `askQuestion` are the only ways a bot reaches a chat.
 */
export class BotRuntime implements AgentRuntime {
  readonly #harness: Harness
  readonly #options: BotRuntimeOptions
  /** Prepares images for the model: the owner's, and those `read` returns. */
  readonly #images: ImageProcessor
  /** Serialises creating a bot's history. */
  readonly #histories = new Map<string, Promise<Conversation>>()
  /** Each bot's work waiting for its current run, in the order it will run (see `rank`). */
  readonly #queues = new Map<string, Queued[]>()
  /** The run each bot's driver started and is waiting on. */
  readonly #turns = new Map<string, Turn>()
  /** Bots whose driver is running their queue. */
  readonly #drivers = new Set<string>()
  /** Serialises submitting each bot's inputs, so they reach its history in the order they were woken. */
  readonly #submitting = new Map<string, Promise<unknown>>()
  /** Bots working, as last reported. */
  readonly #working = new Set<string>()
  #closed = false
  /** Why each bot's latest run failed. */
  readonly #errors = new Map<string, string>()
  /** Messages each bot has sent in its current group turn, by the turn's input id. */
  readonly #groupMessages = new Map<string, { inputId: string; sent: number }>()

  private constructor(harness: Harness, options: BotRuntimeOptions, images: ImageProcessor) {
    this.#harness = harness
    this.#options = options
    this.#images = images
  }

  static async open(options: BotRuntimeOptions): Promise<BotRuntime> {
    const registry = createRegistry()
    const images = await createNodePhotonImages()
    // The hook needs the Harness, which needs the registry; it only runs once the Harness is open.
    let runtime: BotRuntime | undefined
    let harness: Harness | undefined
    /** The conversation that started each computer-use session. */
    const owners = new Map<ConversationId, ConversationId>()
    const botOf = async (conversationId: ConversationId): Promise<BotWithChat> => {
      const bot = await findBotByHistory(options.db, toHistoryId(conversationId))
      if (bot) return bot
      // A computer-use session belongs to the bot whose history started it.
      let owner = owners.get(conversationId)
      if (owner === undefined) {
        const session = harness && (await harness.conversation(conversationId, context))
        owner = session ? (await session.commit((tx) => tx.conversation(conversationId), context))?.owner?.conversationId : undefined
        if (owner === undefined) throw new Error('This history belongs to no bot')
        owners.set(conversationId, owner)
      }
      return botOf(owner)
    }
    const computerUseSessions = computerUse({
      browser: options.browser,
      desktop: options.desktop,
      computer: options.computer,
      images,
      botOf,
      model: async (bot) => {
        const { computerUseModel, defaultModel } = await readModelSettings(options.db)
        const model = computerUseModel ?? bot.model ?? defaultModel
        if (!model) throw new NoModelError('Choose a computer-use or default model first')
        return parseModelRef(model)
      },
      screenFree: (bot) => options.screenFree(bot.id),
      waitingTakeOver: async (bot) => (await findWaitingTakeOver(options.db, bot.chatId))?.card.instruction ?? null,
      requestTakeOver: options.requestTakeOver,
    })
    /** Files on the bot's computer to attach, read before posting so a missing file fails the call and posts nothing. */
    const readAttachments = (bot: BotWithChat, paths: readonly string[]) =>
      Promise.all(
        paths.map(async (path): Promise<AttachmentFile> => {
          const file = await options.computer.readFile(bot, path)
          const name = basename(file.path)
          return { name, mimeType: mimeTypeOf(name), path: file.path, bytes: file.bytes }
        }),
      )
    const attachmentsParameter = Type.Optional(
      Type.Array(Type.String(), {
        description: 'Paths of files on your computer to attach, absolute or relative to your folder',
        maxItems: maxAttachments,
      }),
    )
    const sendMessage: BotTool = {
      // Messages are never reviewed, whether to the owner or another bot.
      surface: null,
      tool: defineTool({
        name: 'sendMessage',
        description:
          'Send the owner one chat message, in Markdown, optionally with files from your computer attached. This is the ' +
          'only way the owner sees anything from you. On your turn in a group chat, it goes to the group.',
        parameters: Type.Object({
          text: Type.String({ description: 'The message, in Markdown; may be empty when you attach files' }),
          attachments: attachmentsParameter,
        }),
        // A replayed call finds the message it already posted.
        replay: 'safe',
        execute: async (args, api) => {
          const bot = await botOf(api.conversationId)
          const paths = args.attachments ?? []
          if (!args.text.trim() && !paths.length) throw new Error('Write a message or attach a file')
          const turn = await runtime!.inputOf(api.conversationId)
          const groupChatId = turn?.groupChatId
          if (groupChatId && isPass(args.text) && !paths.length) return { output: [{ type: 'text', text: 'Passed: nothing was posted.' }] }
          // The owner may have removed the bot while its turn waited or ran.
          if (groupChatId && !(await getGroup(options.db, groupChatId))?.members.includes(bot.id)) {
            throw new Error('You are no longer in this group chat; nothing was posted.')
          }
          // Counted before posting, so calls of one round can't all pass the check at once.
          const release = groupChatId ? runtime!.countGroupMessage(bot.id, turn.id ?? '') : undefined
          if (release === null) {
            const { maxMessagesPerMemberTurn } = groupRoundRules
            throw new Error(`You can send at most ${maxMessagesPerMemberTurn} messages in one turn in a group chat; this one wasn't sent.`)
          }
          try {
            const attachments = await readAttachments(bot, paths)
            await options.sendMessage(bot, groupChatId ?? bot.chatId, { text: args.text, attachments }, `${api.conversationId}:${api.callId}`)
          } catch (error) {
            release?.()
            throw error
          }
          // A run ends only when every call of its last round asks it to, so a message sent beside a question must too.
          const round = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools ?? []
          const asks = round.some((slot) => slot.name === 'askQuestion')
          return { output: [{ type: 'text', text: 'Sent.' }], ...(asks && { control: { terminate: true } }) }
        },
      }),
    }
    // Grok's SendToAgent: asynchronous, never reviewed, shown in both bots' DMs.
    const messageBot: BotTool = {
      surface: null,
      tool: defineTool({
        name: 'message_bot',
        description:
          "Send one of your teammates, the owner's other bots, a message, or post to a group chat you are in. It returns at " +
          'once: never wait for an answer; a reply, if any, wakes you later. The owner sees it in both your chats, or in the group.',
        parameters: Type.Object({
          to: Type.String({ description: "The teammate's name, e.g. Rex, or a group chat's name, e.g. Launch team" }),
          text: Type.String({ description: `The message, in Markdown, at most ${maxBotMessageLength} characters; may be empty when you attach files` }),
          attachments: attachmentsParameter,
          priority: Type.Optional(
            Type.Boolean({
              description: "Only when it can't wait: it goes ahead of their other work and interrupts it, unless they are working for the owner",
            }),
          ),
        }),
        // A replayed call finds the messages it already posted, and the recipient's history the input it was woken with.
        replay: 'safe',
        execute: async (args, api) => {
          const sender = await botOf(api.conversationId)
          const recipient = await findBotByName(options.db, args.to)
          const group = recipient ? undefined : await findGroupByName(options.db, args.to)
          if (!recipient && !group) {
            const others = (await listBots(options.db)).filter((bot) => bot.id !== sender.id).map((bot) => bot.name)
            const team = others.length ? `Your teammates are ${others.join(', ')}.` : 'You have no teammates.'
            const groups = (await listGroups(options.db, sender.id)).map((entry) => `"${entry.name}"`)
            throw new Error(`There is no bot or group chat named ${args.to}. ${team}${groups.length ? ` Your group chats are ${groups.join(', ')}.` : ''}`)
          }
          if (recipient?.id === sender.id) throw new Error("You can't message yourself")
          if (group && !group.members.includes(sender.id)) throw new Error(`You aren't in the group chat "${group.name}"; only its members can post to it.`)
          if (group && (await runtime!.inputOf(api.conversationId))?.groupChatId === group.id) {
            throw new Error(`It is your turn in "${group.name}": reply there with sendMessage.`)
          }
          const paths = args.attachments ?? []
          if (!args.text.trim() && !paths.length) throw new Error('Write a message or attach a file')
          if (args.text.length > maxBotMessageLength) {
            throw new Error(
              `Messages to bots are at most ${maxBotMessageLength} characters; this one has ${args.text.length}. ` +
                'Shorten it, or write the details to a file and attach it.',
            )
          }
          const attachments = await readAttachments(sender, paths)
          // Not a bot, so a group chat.
          if (!recipient) {
            await options.messageGroup(sender, group!, { text: args.text, attachments }, `${api.conversationId}:${api.callId}`)
            return { output: [{ type: 'text', text: `Posted in "${group!.name}". Don't wait for answers: the members answer in turn.` }] }
          }
          const incoming = await options.messageBot(sender, recipient, { text: args.text, attachments }, `${api.conversationId}:${api.callId}`)
          const priority = args.priority ?? false
          try {
            await runtime!.wake(recipient.id, {
              lane: 'bot',
              text: describeBotMessage(sender, args.text, priority),
              attachments: incoming.attachments,
              id: incoming.id,
              priority,
            })
          } catch (error) {
            return { output: [{ type: 'text', text: `Posted, but ${recipient.name} can't be woken: ${(error as Error).message}` }] }
          }
          return {
            output: [{ type: 'text', text: `Sent to ${recipient.name}. Don't wait for an answer: a reply, if any, wakes you later.` }],
          }
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
          if ((await runtime!.inputOf(api.conversationId))?.groupChatId) {
            throw new Error("Cards can't be asked in a group chat. Ask in a message with sendMessage instead.")
          }
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
    // A computer-use session is reviewed, and logged with its reason, as a whole; its browser and desktop tools are not
    // one by one.
    const useComputer: BotTool = { surface: 'computer_session', tool: computerUseSessions.useComputer }
    const tools = [sendMessage, messageBot, askQuestion, ...computerTools(images), useComputer, ...(options.tools ?? [])]
    const toolSurfaces = new Map<string, Surface | null>([
      ...tools.map(({ surface, tool }) => [tool.name, surface] as const),
      // Sessions don't select this extension, so its hooks shouldn't see their browser and desktop tools; if they ever
      // do, those calls were covered by the session's review.
      ...computerUseSessions.sessionToolNames.map((name) => [name, null] as const),
    ])
    const bots = defineExtension({
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
    })
    // Bots' histories select only their own extension; the browser and desktop tools are only in computer-use sessions
    // (ADR 0008).
    registry.install(bots)
    registry.install(computerUseSessions.extension)
    const storage: Storage = options.storagePath ? await openNodeSqliteStorage(options.storagePath) : new MemoryStorage()
    harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry,
        settings: { extensions: [bots] },
        // Each tool call runs in its bot's environment on the computer.
        env: async ({ conversationId }) => options.computer.env(await botOf(conversationId)),
        onReport: (error) => console.error('[agent]', error),
      },
      context,
    )
    runtime = new BotRuntime(harness, options, images)
    harness.resume()
    return runtime
  }

  /**
   * Queues `input` (see `AgentRuntime.wake`). Each bot has one driver, which runs its queue one input at a time: it
   * submits the next input once its history is idle and waits for the run to end. The owner steers a run that is going
   * instead of queueing, and the run is theirs from then on.
   */
  async wake(botId: string, input: BotInput): Promise<void> {
    await this.#wake(botId, input)
  }

  async takeTurn(botId: string, input: BotInput): Promise<void> {
    let settle!: () => void
    const ended = new Promise<void>((resolve) => (settle = resolve))
    if (!(await this.#wake(botId, { ...input, settle }))) return
    await ended
  }

  /** Queues `input`, or steers the run going with it; false when it was there already, or steered. */
  async #wake(botId: string, input: Queued): Promise<boolean> {
    const bot = await getBot(this.#options.db, botId)
    if (!bot) throw new Error(`Unknown bot ${botId}`)
    await this.#model(bot)
    this.#errors.delete(botId)
    const turn = this.#turns.get(botId)
    const queue = this.#queues.get(botId) ?? []
    if (input.id && (turn?.input.id === input.id || queue.some((queued) => queued.id === input.id))) return false
    this.#setWorking(botId)
    if (turn && steerable(input, turn)) {
      turn.lane = 'owner'
      turn.steers++
      await this.#submit(bot, input, 'steer')
      return false
    }
    enqueue(queue, input)
    this.#queues.set(botId, queue)
    if (input.priority && turn && turn.lane !== 'owner') this.#interrupt(botId, turn)
    this.#drive(botId)
    return true
  }

  /** What the input of the bot's current run, the newest in its history, recorded: its lane and group chat. */
  async inputOf(conversationId: ConversationId): Promise<InputRecord | undefined> {
    const history = await this.#harness.conversation(conversationId, context)
    if (!history) return undefined
    let cursor
    do {
      const page = await history.entries({}, 100, cursor, context)
      for (const entry of page.items) if (entry.kind === inputKind) return entry.data as InputRecord
      cursor = page.next
    } while (cursor)
  }

  /**
   * Every tool call in the bot's history, oldest first, with its arguments; for evals. Calls of its computer-use
   * sessions are in their own histories, not here.
   */
  async toolCalls(botId: string): Promise<{ tool: string; args: unknown }[]> {
    const history = await this.#existingHistory(botId)
    if (!history) return []
    const calls: { tool: string; args: unknown }[][] = []
    let cursor
    do {
      const page = await history.entries({}, 100, cursor, context)
      for (const entry of page.items) {
        const blocks = (entry.model ?? []).flatMap((message) => (message.role === 'assistant' ? message.content : []))
        calls.push(blocks.flatMap((block) => (block.type === 'toolCall' ? [{ tool: block.name, args: block.arguments }] : [])))
      }
      cursor = page.next
    } while (cursor)
    // Pages read from the newest entry back.
    return calls.reverse().flat()
  }

  /**
   * Counts a message the bot is about to send in its group turn `inputId`: returns a function taking it back if it
   * isn't sent, or null when the turn already sent `maxMessagesPerMemberTurn`.
   */
  countGroupMessage(botId: string, inputId: string): (() => void) | null {
    const count = this.#groupMessages.get(botId)
    const current = count?.inputId === inputId ? count : { inputId, sent: 0 }
    if (current.sent >= groupRoundRules.maxMessagesPerMemberTurn) return null
    current.sent++
    this.#groupMessages.set(botId, current)
    return () => current.sent--
  }

  async stop(botId: string): Promise<void> {
    this.#drop(botId)
    const turn = this.#turns.get(botId)
    const steers = turn?.steers
    // After any submission under way, so an input being submitted now is aborted too.
    await this.#serially(botId, async () => (await this.#existingHistory(botId))?.abort(context))
    // The abort resolves once the history is idle; report it now rather than when the driver notices, unless the bot
    // was woken again meanwhile.
    if (!this.#queues.get(botId)?.length && this.#turns.get(botId)?.steers === steers) this.#setIdle(botId)
  }

  async forget({ id, name, historyId }: { id: string; name: string; historyId: string | null }): Promise<void> {
    this.#drop(id)
    if (historyId) await (await this.#harness.conversation(toConversationId(historyId), context))?.abort(context)
    try {
      await this.#options.computer.removeFolder({ id, name })
    } catch (error) {
      // The bot is gone either way; a folder left behind is only clutter.
      console.error(`[agent] Couldn't delete ${name}'s folder:`, error)
    }
    // pi-durable can't delete a conversation, so the history stays in its storage with no bot to reach it.
    this.#histories.delete(id)
    this.#submitting.delete(id)
    this.#working.delete(id)
    this.#errors.delete(id)
    this.#groupMessages.delete(id)
  }

  /** Drops the work queued behind the bot's run; those waiting on it are told it ended. */
  #drop(botId: string) {
    const queue = this.#queues.get(botId) ?? []
    this.#queues.delete(botId)
    for (const input of queue) input.settle?.()
  }

  status(botId: string): BotStatus {
    return { working: this.#working.has(botId), error: this.#errors.get(botId) ?? null }
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const botId of [...this.#queues.keys()]) this.#drop(botId)
    await this.#harness.close(context)
    await this.#options.computer.close()
    await this.#options.desktop.close?.()
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
          // A group turn may pass: the guarantee covers the owner's own messages to the bot.
          const data = entry.data as InputRecord | undefined
          const owed = data?.lane === 'owner' && !data.groupChatId
          return owed && reminders < maxReplyReminders ? { continue: replyReminder } : undefined
        }
      }
      cursor = page.next
    } while (cursor)
  }

  /** What the model reads of an input: its text, where its files are, then its images. */
  async #content(bot: BotWithChat, { lane, text, attachments = [] }: BotInput): Promise<string | (TextContent | ImageContent)[]> {
    if (!attachments.length) return text
    const by = lane === 'bot' ? 'The sender' : 'The owner'
    const parts: (TextContent | ImageContent)[] = [{ type: 'text', text: [text, describeAttachments(attachments, by)].filter(Boolean).join('\n\n') }]
    for (const file of attachments) {
      if (!file.mimeType.startsWith('image/')) continue
      try {
        const { bytes } = await this.#options.computer.readFile(bot, file.path)
        // A plain copy: the processor transfers the bytes' buffer to its worker, which a Buffer's shared pool can't be.
        const image = await this.#images.prepare(new Uint8Array(bytes), file.mimeType, DEFAULT_IMAGE_LIMITS)
        // One that can't be shown, e.g. an SVG, is still on the computer for the bot's tools.
        if (image) parts.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      } catch (error) {
        console.error(`[agent] Couldn't show ${bot.name} ${file.path}:`, error)
      }
    }
    return parts
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

  /** The bot's model, or `NoModelError`. */
  async #model(bot: BotWithChat): Promise<ModelRef> {
    const model = bot.model ?? (await readModelSettings(this.#options.db)).defaultModel
    if (!model) throw new NoModelError('Choose a default model first')
    return parseModelRef(model)
  }

  /** Runs `work` after the bot's earlier submissions and aborts, so they reach its history in the order they were made. */
  #serially<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const done = (this.#submitting.get(botId) ?? Promise.resolve()).then(work, work)
    this.#submitting.set(botId, done.catch(() => {}))
    return done
  }

  /** The bot's history, if it has one yet. */
  async #existingHistory(botId: string): Promise<Conversation | undefined> {
    const pending = this.#histories.get(botId)
    if (pending) return pending.catch(() => undefined)
    const bot = await getBot(this.#options.db, botId)
    return bot?.historyId ? this.#harness.conversation(toConversationId(bot.historyId), context) : undefined
  }

  /** Configures the bot's history as the bot is now and submits `input`, after its earlier submissions. */
  #submit(bot: BotWithChat, input: BotInput, whenBusy: 'steer' | 'followUp'): Promise<Submission> {
    return this.#serially(bot.id, async () => {
      const history = await this.#history(bot)
      const others = (await listBots(this.#options.db)).filter((other) => other.id !== bot.id)
      const groups = await listGroups(this.#options.db, bot.id)
      const instructions = [botPrompt(bot), computerPrompt(this.#options.computer, bot, others), teamPrompt(others), groupsPrompt(bot, groups)]
        .filter(Boolean)
        .join('\n\n')
      await history.configure({ model: await this.#model(bot), instructions }, context)
      const submission = await history.submit(
        {
          type: 'input',
          content: await this.#content(bot, input),
          requestId: input.id,
          whenBusy,
          entry: {
            kind: inputKind,
            data: { lane: input.lane, ...(input.groupChatId && { groupChatId: input.groupChatId }), ...(input.id && { id: input.id }) } satisfies InputRecord,
          },
        },
        context,
      )
      void this.#reportFailure(bot.id, submission)
      return submission
    })
  }

  /** Runs the bot's queue until it is empty, unless a driver already is. */
  #drive(botId: string) {
    if (this.#drivers.has(botId)) return
    this.#drivers.add(botId)
    void (async () => {
      for (let input; !this.#closed && (input = this.#queues.get(botId)?.shift()); ) {
        const turn: Turn = { input, lane: input.lane, interrupted: false, steers: 0 }
        this.#turns.set(botId, turn)
        try {
          const bot = await getBot(this.#options.db, botId)
          if (!bot) break // Deleted.
          turn.submission = await this.#submit(bot, input, 'followUp')
          const history = await this.#history(bot)
          // Until the run ends, and any run an owner's steer started after it.
          let steers
          do {
            steers = turn.steers
            await history.waitForIdle(context)
            await this.#submitting.get(botId)
          } while (steers !== turn.steers)
        } catch (error) {
          if (this.#closed) break
          console.error(`[agent] Bot ${botId}'s run couldn't start:`, error)
          this.#errors.set(botId, (error as Error).message)
          this.#options.onStatus(botId, this.status(botId))
        } finally {
          this.#turns.delete(botId)
          input.settle?.()
        }
      }
      this.#drivers.delete(botId)
      if (!this.#queues.get(botId)?.length) this.#queues.delete(botId)
      this.#setIdle(botId)
    })()
  }

  /**
   * A priority input interrupts `turn`: its run is aborted and its input queued again behind the priority one, once.
   * Decided after the turn's submission, in order with the owner's steers: a run the owner steered meanwhile is theirs,
   * and one that already ended has nothing to interrupt.
   */
  #interrupt(botId: string, turn: Turn) {
    if (turn.interrupted) return
    turn.interrupted = true
    void this.#serially(botId, async () => {
      if (turn.lane === 'owner' || this.#turns.get(botId) !== turn) return
      const settled = turn.submission && (await turn.submission.status(context)).status
      if (settled === 'done' || settled === 'unanswered') return
      const { input } = turn
      if (!input.redelivered) {
        const queue = this.#queues.get(botId) ?? []
        enqueue(queue, { ...input, text: `${interruptedNote}\n\n${input.text}`, id: input.id && `${input.id}:redelivered`, redelivered: true })
        // Whoever waits on the work waits for it to be done again.
        input.settle = undefined
        this.#queues.set(botId, queue)
      }
      await (await this.#existingHistory(botId))?.abort(context)
    }).catch((error) => console.error(`[agent] Couldn't interrupt bot ${botId}:`, error))
  }

  #setWorking(botId: string) {
    if (this.#working.has(botId)) return
    this.#working.add(botId)
    this.#options.onStatus(botId, this.status(botId))
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
