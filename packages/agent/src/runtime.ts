import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { type ImageContent, type Models, type TextContent, Type } from '@earendil-works/pi-ai'
import {
  type CompactionPolicy,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  GenerationTask,
  type JsonObject,
  Harness,
  LiveDoc,
  MemoryStorage,
  type ModelRef,
  type Storage,
  type Submission,
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  hook,
  section,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createToolSearchExtension, TOOL_SEARCH_TOOL_NAME } from '@earendil-works/pi-durable/tool-search'
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
  botsOwingReplies,
  type Clock,
  type ExchangePart,
  type RunExchange,
  defaultImportance,
  editFact,
  factTiers,
  forgetFact,
  frozenMemoryBlock,
  frozenRoutinesBlock,
  InvalidRoutineError,
  localTime,
  maxRoutineNameLength,
  maxRoutinesPerBot,
  NoSuchRoutineError,
  type RoutineChangeCard,
  type RoutineChangeKind,
  type Routines,
  type RoutineState,
  maxFactLength,
  maxImportance,
  minImportance,
  ownerTimeZone,
  type MemoryScope,
  reachableFactScope,
  systemClock,
  writeFact,
  describeUnanswered,
  findBotByHistory,
  findBotByName,
  findGroupByName,
  getGroup,
  othersIn,
  pruneTakenInputs,
  findWaitingTakeOver,
  getBot,
  type Group,
  keepInput,
  keptInput,
  type KeptInput,
  groupRoundRules,
  listGroups,
  type Lane,
  listBots,
  markReminded,
  maxAttachments,
  maxBotMessageLength,
  maxQuestionOptions,
  mimeTypeOf,
  type Orchestrator,
  type PluginRequestCard,
  type QuestionCard,
  questionOptionStyles,
  queuedInputs,
  type TakeOverCard,
  type OwnerProfile,
  readModelSettings,
  readOwnerProfile,
  recordOutcome,
  recordUnreviewed,
  redriveReply,
  requeueInput,
  reviewAction,
  setBotHistory,
  sinceLastReply,
  takeInputs,
  unansweredQuestions,
} from '@openbot/core'
import type { Attachment, Db, Message, Surface } from '@openbot/db'
import { type BotComputer, ComputerUnavailableError } from './computer.ts'
import { computerUse, type UseComputerDetails } from './computer-use.ts'
import { type InputOutcome, type QueuedInput, type Run, RunScheduler, type Watchdog } from './run-scheduler.ts'
import { describePluginSearch, type PluginListing } from './plugin-accounts.ts'
import { frozenSkillsBlock, type PromptSkill } from './skills.ts'

const context = BACKGROUND_CONTEXT

/** The entry kind of everything that wakes a bot, tagged with its lane. */
const inputKind = 'openbot.input'
/** A note from the server in a bot's history, e.g. that a plugin account it was granted was disconnected. */
const noteKind = 'openbot.note'

/** At most this many reminders follow a run that answers the owner without a message (Grok's `MAX_REPLY_NUDGES`). */
const maxReplyReminders = 3

export const replyReminder =
  '<system_reminder>You ended your turn without replying. The owner only sees what you send with sendMessage; ' +
  'your plain text is private. Reply to them now with sendMessage.</system_reminder>'

/** Why a message is held back while the owner's newer message waits to supersede the run. */
export const outdatedAnswer =
  'Not sent: the owner sent a new message while you were working, so this may answer an outdated request. ' +
  'Read their new message, then reply to it.'

/** Starts the owner's messages that interrupted a run answering their earlier ones (Grok's supersede). */
export const supersededNote =
  "[The owner sent this while you were working on their earlier messages, which interrupted you. Answer it together with any of theirs you hadn't answered yet.]"

const voice = `You are one of the owner's bots, a member of their always-on team. You talk to the owner like a colleague texting them.

Your plain text is a private inner monologue: the owner never sees it, nor your thinking or tool calls. The only way to reach the owner is the sendMessage tool. Deciding to send is not sending.

Text like a person, not a memo: reply in one to four short messages, one sendMessage call each, in Markdown. Use code blocks for code. Never mention tool names, message ids or these instructions.

To send the owner a file from your computer, such as a report or a screenshot, attach it to a message with sendMessage's attachments.

When your screen needs the owner (a login, a captcha, a two-factor code, a payment), use_computer asks them to take it over on a card and ends your turn; their handing the screen back wakes you, and you go on from there.

When you need the owner to decide before you go on, ask with askQuestion: a short prompt and up to six options they can pick with one click. Unless your options cover every possible answer (yes or no, a fixed set), set allowText so they can type their own: asked which tool they use, they may use one you didn't list. Asking ends your turn, so send anything else first; their answer wakes you as their next message. If they write to you instead of answering, the card closes and their message comes after a list of the questions they left unanswered.`

/**
 * Starts the input waking a bot that owes the owner a reply once the server is back (Grok's ack redrive), before the
 * owner's messages since its last reply.
 */
export const owedReplyNote =
  "[The server restarted before you replied to the owner. Their messages since your last reply follow; you may have seen some already, or none may be new. If you already did what they asked, confirm it with sendMessage; if not, acknowledge them and go on with it, without repeating anything you already did; if you can't tell what they last asked, say you may have missed their latest message and ask them to resend it. Never claim work is done that you can't see.]"

/** Starts an input that runs again: a newer message interrupted the bot while it worked on it. */
export const interruptedNote = '[You were interrupted by a newer message while working on this. Pick it up again.]'

export class NoModelError extends Error {}

export type BotStatus = {
  working: boolean
  /** Why the bot's latest run failed, e.g. its provider rejected the request; cleared when it is woken again. */
  error: string | null
}

/**
 * The surface the orchestrator reviews a tool's calls under; null for calls without side effects. A function decides it
 * per call, from the call's arguments and its bot, for a tool whose calls aren't all alike (e.g. `update_state`), and
 * may give the arguments the call then runs with, pinned to what was reviewed.
 */
export type ToolSurface =
  | Surface
  | null
  | ((args: any, botId: string) => Promise<{ surface: Surface | null; arguments?: JsonObject }>)

/** A bot's tool and the surface the orchestrator reviews its calls under. */
export type BotTool = {
  surface: ToolSurface
  tool: ToolRegistration<any, any>
  /** The MCP server a plugin tool calls, `<plugin>_<accountN>`, as its calls are audited. */
  server?: string
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
   * The tools only this bot has, e.g. the plugin tools the owner granted it: deferred, so the bot is offered them once
   * it loads them with tool_search. Asked before each of its runs, and again at each call of one of them, so a tool it
   * lost since (a grant revoked) fails cleanly.
   */
  botTools?(botId: string): Promise<BotTool[]>
  /** The skills bot `botId` may read, e.g. those of the plugins it is granted; listed in its prompt from its next compaction epoch. */
  botSkills?(botId: string): Promise<PromptSkill[]>
  /**
   * Posts a bot's message, with copies of the files it attached, to chat `chatId`: its DM, or the group chat whose turn
   * it is taking. `idempotencyKey` makes a replayed tool call post once.
   */
  sendMessage(
    bot: BotWithChat,
    chatId: string,
    message: { text: string; attachments: AttachmentFile[] },
    idempotencyKey: string,
    /** The id of the input whose run sends it, when it has one, e.g. a routine's run. */
    inputId?: string,
  ): Promise<void>
  /**
   * Posts a bot's message to a group chat it belongs to, outside its turns, as `sendMessage` posts but text only; the
   * members answer it in rounds, as they answer the owner.
   */
  messageGroup(sender: BotWithChat, group: Group, message: { text: string }, idempotencyKey: string): Promise<void>
  /**
   * Posts one bot's message to another, as `sendMessage` posts: outgoing in the sender's DM and incoming in the
   * recipient's, each with copies of the images. Returns the recipient's copy, which wakes it.
   */
  messageBot(
    sender: BotWithChat,
    recipient: BotWithChat,
    message: { text: string; attachments: AttachmentFile[] },
    idempotencyKey: string,
  ): Promise<Message>
  /** Bots' routines, which each bot manages through `update_state`'s `routine` target (design §5.4): only its own. */
  routines: Pick<Routines, 'get' | 'create' | 'update' | 'pause' | 'resume' | 'delete'>
  /** Posts the timeline row of a bot's change to its own routine in its DM, as `askQuestion` posts a card. */
  postRoutineChange(bot: BotWithChat, card: RoutineChangeCard, idempotencyKey: string): Promise<void>
  /** The plugin catalog, each plugin with bot `botId`'s status for it, for `search_plugins`. */
  searchPlugins(botId: string): Promise<PluginListing[]>
  /** Posts a bot's plugin request card to its DM, as `askQuestion` posts a question. */
  requestPlugin(bot: BotWithChat, card: PluginRequestCard, idempotencyKey: string): Promise<void>
  /** Posts a bot's question card to its DM, as `sendMessage` posts a message. */
  askQuestion(bot: BotWithChat, card: QuestionCard, idempotencyKey: string): Promise<void>
  /** Posts a take-over card to a bot's DM when its computer-use session is stuck on what only the owner can do. */
  requestTakeOver(bot: BotWithChat, card: TakeOverCard, idempotencyKey: string): Promise<void>
  /** A bot's status changed: it started or finished working, or a run failed. */
  onStatus(botId: string, status: BotStatus): void
  /** When a run the owner's message waits for is interrupted again, then detached; Grok's 120 s and 30 s by default. */
  watchdog?: Watchdog
  /** Downloads the https:// images bots send each other; the global `fetch` by default. */
  fetch?: typeof fetch
  /** When and how much bots' histories are compacted; pi-durable's defaults otherwise. Tests keep less verbatim. */
  compaction?: Partial<CompactionPolicy>
  /** The server's time, which memory facts are dated and ranked by; the system's by default. */
  clock?: Clock
  /**
   * A bot's run settled, in any lane, however it ended; `exchange` reads it back, as memory extraction does. Called in
   * the order the bot's runs settle, never holding up its next run.
   */
  onRunSettled?(botId: string, exchange: () => Promise<RunExchange | undefined>): void
  /**
   * The run of a bot- or background-lane input (`BotInput.id`) ended for good, answered or failed, e.g. a routine's;
   * across restarts too. Not called while it runs again after an interrupt, nor once the bot is deleted.
   */
  onInputSettled?(botId: string, inputId: string, outcome: InputOutcome): void
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

/** Who the owner is, as they introduced themselves; empty until they have. */
function ownerPrompt({ name, about }: OwnerProfile): string {
  const lines = name ? [`The owner's name is ${name}.`] : []
  if (about) lines.push(`What the owner wrote about themselves, for all their bots:\n\n${about}`)
  return lines.join(' ')
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
    '',
    "Always check search_plugins before using the browser for a service such as Notion or Linear: a plugin gives you proper tools for it. If one covers the service and you aren't granted it, ask the owner for it with request_plugin.",
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

/** The largest image message_bot downloads from an https:// URL, and how long it waits for one. */
const maxDownloadedImageBytes = 20 * 1024 * 1024
const imageDownloadTimeoutMs = 30_000

/** Downloads an https:// image a bot sends another; throws unless it is an image within the limit. */
async function downloadImage(fetchImage: typeof fetch, url: string): Promise<Omit<AttachmentFile, 'path'>> {
  let response: Response
  try {
    response = await fetchImage(url, { signal: AbortSignal.timeout(imageDownloadTimeoutMs) })
  } catch (error) {
    throw new Error(`Couldn't download ${url}: ${(error as Error).message}`)
  }
  if (!response.ok) throw new Error(`Couldn't download ${url}: HTTP ${response.status}`)
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!mimeType.startsWith('image/')) {
    await response.body?.cancel()
    throw new Error(`${url} isn't an image (${mimeType || 'no type'}): message_bot only carries images`)
  }
  const tooLarge = new Error(`${url} is larger than ${maxDownloadedImageBytes / 1024 / 1024} MB`)
  if (Number(response.headers.get('content-length')) > maxDownloadedImageBytes) {
    await response.body?.cancel()
    throw tooLarge
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  for (let read = await reader?.read(); read && !read.done; read = await reader!.read()) {
    size += read.value.byteLength
    if (size > maxDownloadedImageBytes) {
      await reader!.cancel()
      throw tooLarge
    }
    chunks.push(read.value)
  }
  let name = basename(new URL(url).pathname)
  try {
    name = decodeURIComponent(name)
  } catch {}
  // Named so the recipient's tools see an image, e.g. a CDN's extensionless `photo` saved as `photo.png`.
  if (!mimeTypeOf(name).startsWith('image/')) name = `${name || 'image'}.${mimeType.slice('image/'.length).replace(/\+.*/, '').replace('jpeg', 'jpg')}`
  return { name, mimeType, bytes: Buffer.concat(chunks) }
}

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

/** The tools that reach the owner; any of them answers the owner, and the owner's newer message holds them all back. */
const ownerTools = new Set(['sendMessage', 'askQuestion', 'request_plugin'])

/** The tools that post a card and end the bot's turn until the owner decides. */
const cardTools = new Set(['askQuestion', 'request_plugin'])

/** What a bot reads when it calls one of its own tools that it no longer has. */
const lostTool = (name: string) => `${name} isn't available to you any more: the owner may have revoked it.`

/** The extension holding the tools only bot `botId` has (see `BotRuntimeOptions.botTools`). */
const ownToolsExtension = (botId: string) => `openbot-bot:${botId}`

/** A sendMessage, askQuestion or request_plugin call that succeeded, or a use_computer call that posted a take-over card; a failed one reached nobody. */
const reachedOwner = (entry: EntryRecord) =>
  entry.kind === 'pi.tool-result' &&
  entry.model?.some(
    (message) =>
      message.role === 'toolResult' &&
      !message.isError &&
      (ownerTools.has(message.toolName) ||
        (message.toolName === 'use_computer' && Boolean((message.details as UseComputerDetails | undefined)?.takeOver))),
  )

/** The tools a bot sends its own messages with: to the owner or a group, to teammates, and questions. */
const sendingTools = new Set(['sendMessage', 'message_bot', 'askQuestion'])

/**
 * A tool call of the bot's as extraction reads it: a message it sent, or context, marked when `acts` says the tool
 * acts.
 */
function sentOrCalled(name: string, args: Record<string, unknown>, acts: (name: string) => boolean): ExchangePart {
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  if (name === 'sendMessage') return { from: 'bot', text: text('text') }
  if (name === 'message_bot') return { from: 'bot', text: text('text'), to: text('to') }
  if (name === 'askQuestion') return { from: 'bot', text: text('prompt') }
  return { from: 'context', kind: 'tool_call', label: `your call of ${name}`, text: JSON.stringify(args), ...(acts(name) && { acts: true as const }) }
}

/**
 * Owner-lane inputs in the bot's DM that aren't only the owner's own words: an answer to a question card (it quotes the
 * bot's question and options), a screen handed back, and a reply the server re-drives after a restart (its note, and
 * messages the run they woke already read).
 */
const notOwnerWords = /^(answer|hand-back|owed-reply):/

/** The owner's own message in the bot's DM, as the router wakes the bot with it: not a group chat's turn, nor the above. */
const isOwnerDmInput = (input: BotInput) => input.lane === 'owner' && !input.groupChatId && !notOwnerWords.test(input.id ?? '')

/** Where an input other than the owner's DM message came from, as extraction's context labels it. */
const describeInputSource = (input: BotInput) =>
  input.groupChatId
    ? 'a group chat turn'
    : input.lane === 'owner'
      ? 'a card the owner answered, or a note from the server'
      : input.lane === 'bot'
        ? "a teammate's message"
        : 'a background wake, e.g. a routine'

/** Why a run ended without an answer, from its submission's record. */
function describeFailure({ detail, reason }: { detail?: unknown; reason?: string }): string {
  return typeof detail === 'string' ? detail : detail === undefined ? String(reason) : JSON.stringify(detail)
}

/**
 * The tools only some bots have (`BotRuntimeOptions.botTools`), each bot's in an extension of its own that only its
 * history selects, so no other bot finds or calls them.
 */
type OwnTools = {
  /**
   * Installs the bot's tools as they are now: the extensions its history selects, null for the default, or undefined
   * to leave them as they were when its tools can't be read.
   */
  install(botId: string): Promise<Extension[] | null | undefined>
  /** Whether a call of the bot's own tool `name` acts: it is reviewed under a fixed surface. */
  acts(botId: string, name: string): boolean
  forget(botId: string): void
}

/** What an input's entry in the history records: its lane, and the group chat whose turn it is. */
type InputRecord = { lane: Lane; groupChatId?: string; id?: string }

/** The request id of a run's inputs, so a replayed submission finds its run; each attempt of an input is its own. */
function requestIdOf(inputs: readonly QueuedInput[]): string | undefined {
  const ids = inputs.map((input) => input.id && (input.attempt ? `${input.id}:attempt-${input.attempt + 1}` : input.id))
  return ids.every(Boolean) ? ids.join(' ') : undefined
}

/** The ids of the inputs of the run whose request id is `requestId` (see `requestIdOf`). */
const inputIdsOf = (requestId: string) => requestId.split(' ').map((token) => token.replace(/:attempt-\d+$/, ''))

/** What of a queued input is kept across restarts: all but what only this process can use. */
const toKept = ({ settle: _settle, supersedes: _supersedes, ...input }: QueuedInput) => input as KeptInput

/**
 * Whether an input is kept across restarts: those of the bot and background lanes. The owner's are not: their messages
 * are in their DM, and a bot owing them a reply is woken to give it (`owedReplyNote`); a group chat's turns end with its
 * rounds, as the server stops.
 */
const isKept = (input: QueuedInput) => input.lane !== 'owner'

/** The ids of the kept inputs among `inputs`; `#wake` gave each one. */
const keptIds = (inputs: readonly QueuedInput[]) => inputs.filter(isKept).map((input) => input.id!)

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
  /** Each bot's queue and its one run at a time. */
  readonly #scheduler: RunScheduler
  /** Why each bot's latest run failed. */
  readonly #errors = new Map<string, string>()
  /** Messages each bot has sent in its current group turn, by the turn's input id. */
  readonly #groupMessages = new Map<string, { inputId: string; sent: number }>()
  /** The texts each bot has sent in its current run, by the run's input id, each with the call that sent it. */
  readonly #sentTexts = new Map<string, { inputId: string; calls: Map<string, string> }>()
  /** The server's time, which memory facts are dated and ranked by. */
  readonly #clock: Clock
  /** The tools that act: those whose calls are reviewed under a fixed surface (see `ExchangePart`'s `acts`). */
  readonly #actingTools: ReadonlySet<string>
  readonly #ownTools: OwnTools
  /** Closing: a run that can't start now is queued still, for the next start. */
  #closing = false

  private constructor(harness: Harness, options: BotRuntimeOptions, images: ImageProcessor, actingTools: ReadonlySet<string>, ownTools: OwnTools) {
    this.#harness = harness
    this.#ownTools = ownTools
    this.#actingTools = actingTools
    this.#options = options
    this.#images = images
    this.#clock = options.clock ?? systemClock
    this.#scheduler = new RunScheduler({
      histories: {
        submit: async (botId, inputs) => {
          let submitted = false
          try {
            const run = await this.#submit(botId, inputs)
            submitted = true
            return run
          } finally {
            // Submitted, pi-durable keeps the run from here on: were this lost, resubmitting the inputs finds their run.
            // A run that couldn't start is dropped, as it would be without a restart, unless the runtime is closing
            // under it: it then starts on the next boot.
            if (submitted || !this.#closing) await takeInputs(this.#options.db, botId, keptIds(inputs))
          }
        },
        idle: async (botId) => (await this.#existingHistory(botId))?.waitForIdle(context),
        abort: async (botId) => (await this.#existingHistory(botId))?.abort(context),
      },
      onWorking: (botId) => this.#options.onStatus(botId, this.status(botId)),
      onError: (botId, error) => {
        console.error(`[agent] Bot ${botId}'s run couldn't start:`, error)
        this.#errors.set(botId, error.message)
        this.#options.onStatus(botId, this.status(botId))
      },
      onRequeue: async (botId, input) => {
        if (!isKept(input)) return
        await requeueInput(this.#options.db, botId, toKept(input)).catch((error) =>
          console.error(`[agent] Couldn't keep bot ${botId}'s interrupted input queued:`, error),
        )
      },
      onSettled: (botId, input, outcome) => {
        if (isKept(input) && input.id) options.onInputSettled?.(botId, input.id, outcome)
      },
      watchdog: options.watchdog,
    })
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
      waitingTakeOver: async (bot) => (await findWaitingTakeOver(options.db, bot.chatId))?.card.instruction ?? null,
      requestTakeOver: options.requestTakeOver,
      audit: (bot, entry) => recordUnreviewed(options.db, bot.id, { ...entry, surface: 'computer_session' }),
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
    /**
     * The images a bot sends another, read before posting so a bad one fails the call and posts nothing: image files on
     * its computer, and https:// images, downloaded into the recipient's uploads folder as the owner's files are.
     */
    const readImages = async (sender: BotWithChat, recipient: BotWithChat, sources: readonly string[]): Promise<AttachmentFile[]> => {
      const read = await Promise.all(
        sources.map(async (source) => {
          if (/^https:\/\//i.test(source)) return downloadImage(options.fetch ?? fetch, source)
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !/^file:/i.test(source)) {
            throw new Error(`${source}: an image is a file on your computer or an https:// URL`)
          }
          const [file] = await readAttachments(sender, [/^file:/i.test(source) ? fileURLToPath(source) : source])
          if (!file!.mimeType.startsWith('image/')) {
            throw new Error(
              `${source} isn't an image: message_bot only carries images. Put other files in ${options.computer.sharedFolder} and say where.`,
            )
          }
          return file!
        }),
      )
      return Promise.all(
        read.map(async (file): Promise<AttachmentFile> =>
          'path' in file ? (file as AttachmentFile) : { ...file, path: await options.computer.saveUpload(recipient, file.name, file.bytes) },
        ),
      )
    }
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
          // Weak models resend a message they already sent in the run, believing the first call went wrong. Claimed
          // before posting, so two calls of one round can't both pass; a replayed call keeps its own claim.
          const unclaim = turn?.id && args.text.trim() && !paths.length ? runtime!.claimText(bot.id, turn.id, args.text, api.callId) : undefined
          if (unclaim === false) {
            return { output: [{ type: 'text', text: 'Not sent again: you already sent the owner this exact message in this turn, and they have it.' }] }
          }
          // Counted before posting, so calls of one round can't all pass the check at once.
          const release = groupChatId ? runtime!.countGroupMessage(bot.id, turn.id ?? '') : undefined
          if (release === null) {
            unclaim?.()
            const { maxMessagesPerMemberTurn } = groupRoundRules
            throw new Error(`You can send at most ${maxMessagesPerMemberTurn} messages in one turn in a group chat; this one wasn't sent.`)
          }
          try {
            const attachments = await readAttachments(bot, paths)
            await options.sendMessage(bot, groupChatId ?? bot.chatId, { text: args.text, attachments }, `${api.conversationId}:${api.callId}`, turn?.id)
          } catch (error) {
            release?.()
            unclaim?.()
            throw error
          }
          // A run ends only when every call of its last round asks it to, so a message sent beside a card must too.
          const round = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools ?? []
          const asks = round.some((slot) => cardTools.has(slot.name))
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
          'once: never wait for an answer; a reply, if any, wakes you later. The owner sees it in both your chats, or in the group. ' +
          'A teammate sees the images you send, as it sees the owner\'s; group posts are text only.',
        parameters: Type.Object({
          to: Type.String({ description: "The teammate's name, e.g. Rex, or a group chat's name, e.g. Launch team" }),
          text: Type.String({ description: `The message, in Markdown, at most ${maxBotMessageLength} characters; may be empty when you send images` }),
          images: Type.Optional(
            Type.Array(Type.String(), {
              description:
                'Images for a teammate, e.g. a screenshot: paths of image files on your computer, absolute or relative to your folder, or https:// URLs. ' +
                'Only images; a group post drops them.',
              maxItems: maxAttachments,
            }),
          ),
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
          const sources = args.images ?? []
          if (!args.text.trim() && (group || !sources.length)) throw new Error(group ? 'Write a message: group posts are text only' : 'Write a message or send an image')
          if (args.text.length > maxBotMessageLength) {
            throw new Error(
              `Messages to bots are at most ${maxBotMessageLength} characters; this one has ${args.text.length}. ` +
                `Shorten it, or write the details to a file in ${options.computer.sharedFolder} and say where.`,
            )
          }
          // Not a bot, so a group chat: text only, as Grok's group posts are.
          if (!recipient) {
            await options.messageGroup(sender, group!, { text: args.text }, `${api.conversationId}:${api.callId}`)
            const dropped = sources.length
              ? ` Note: the image${sources.length === 1 ? ' was' : 's were'} NOT delivered: group posts are text only; send images to a teammate directly.`
              : ''
            return { output: [{ type: 'text', text: `Posted in "${group!.name}". Don't wait for answers: the members answer in turn.${dropped}` }] }
          }
          const attachments = await readImages(sender, recipient, sources)
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
          'Ask the owner to decide, on a card with 1–6 options they answer with one click, and with allowText a box to type ' +
          'their own answer. Asking ends your turn; their answer arrives as their next message. If they write to you ' +
          'instead, the card closes and their message starts with the questions they left unanswered.',
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
          allowText: Type.Optional(
            Type.Boolean({
              description:
                "Also let the owner type their own answer, as an Other choice. Set it whenever the options may not cover " +
                "theirs, e.g. which tool, name or date; leave it off only for a closed choice such as yes or no",
            }),
          ),
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
    const searchPlugins: BotTool = {
      surface: null,
      tool: defineTool({
        name: 'search_plugins',
        description:
          "Search OpenBot's plugin catalog: services such as Notion or Linear you can use through proper tools, each with your " +
          'status: the accounts granted to you, connected but not granted, or not connected. Check it before using the browser for a service.',
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Words to find in a plugin's name or description, e.g. notion; the whole catalog when absent" })),
        }),
        execute: async (args, api) => {
          const bot = await botOf(api.conversationId)
          return { output: [{ type: 'text', text: describePluginSearch(await options.searchPlugins(bot.id), args.query) }] }
        },
      }),
    }
    const requestPlugin: BotTool = {
      surface: 'plugin_request',
      tool: defineTool({
        name: 'request_plugin',
        description:
          "Ask the owner for a plugin from search_plugins that you aren't granted, or for another of its accounts, on a card in " +
          'your chat: they connect an account or pick one to grant you, or deny. Asking ends your turn; their decision wakes you.',
        parameters: Type.Object({
          plugin: Type.String({ description: 'The plugin\'s name, as search_plugins lists it, e.g. notion' }),
          reason: Type.String({ description: 'Why you need it, in one short line the owner reads on the card' }),
        }),
        replay: 'safe',
        execute: async (args, api) => {
          const bot = await botOf(api.conversationId)
          if ((await runtime!.inputOf(api.conversationId))?.groupChatId) {
            throw new Error("Cards can't be posted in a group chat. Ask for the plugin in your own chat with the owner.")
          }
          const reason = args.reason.trim()
          if (!reason) throw new Error('Say why you need the plugin')
          const listings = await options.searchPlugins(bot.id)
          const plugin = listings.find((listing) => listing.name === args.plugin.trim().toLowerCase())
          if (!plugin) {
            throw new Error(`There is no plugin named ${args.plugin}. The catalog's plugins: ${listings.map((listing) => listing.name).join(', ') || 'none'}.`)
          }
          const card: PluginRequestCard = {
            type: 'plugin_request',
            plugin: plugin.name,
            displayName: plugin.displayName,
            reason,
            skillsOnly: plugin.skillsOnly,
          }
          await options.requestPlugin(bot, card, `${api.conversationId}:${api.callId}`)
          return {
            output: [{ type: 'text', text: "Asked. Your turn ends here; the owner's decision will wake you." }],
            control: { terminate: true },
          }
        },
      }),
    }
    // Grok's update_state, with the memory and routine targets. The bot is always the run's, never an argument.
    const updateState: BotTool = {
      // Bot memory isn't reviewed; every write, edit or forget of shared memory is the memory_shared_write surface. An
      // edit or forget runs pinned to the scope its fact had when reviewed, so a shared fact written in between under an id
      // the bot guessed isn't changed unreviewed. A fact the bot can't reach isn't reviewed: the call answers "no such fact".
      // Every change to a routine is the routine_change surface, whichever routine it names.
      surface: async (args: { target: string; action: string; scope?: MemoryScope; id?: number }, botId) => {
        if (args.target === 'routine') return { surface: 'routine_change' }
        if (args.action === 'write') return { surface: args.scope === 'shared' ? 'memory_shared_write' : null }
        const scope = (args.id !== undefined && (await reachableFactScope(options.db, botId, args.id))) || 'bot'
        return { surface: scope === 'shared' ? 'memory_shared_write' : null, arguments: { ...args, scope } }
      },
      tool: defineTool({
        name: 'update_state',
        description:
          'Change your own lasting state.\n\n' +
          'target "memory": the facts you keep across conversations, shown in your ' +
          'instructions with their ids: your bot memory (scope "bot", only yours, mostly about your own work) and shared ' +
          'memory (scope "shared", every bot knows it, mostly about the owner). Save what will matter later (the owner\'s ' +
          'preferences, decisions, how things are done), never secrets or passwords. A fact you write joins your ' +
          'instructions later; until then it is in this conversation. Changes to shared memory are reviewed.\n' +
          '- write: save a new fact (a scope, a tier, the text, an importance).\n' +
          '- edit: change a fact of either scope by its id: its text, tier or importance. A fact never changes scope: forget it and write it anew.\n' +
          '- forget: delete a fact of either scope for good by its id.\n\n' +
          'target "routine": your routines, each an instruction that wakes you on a schedule in the owner\'s time zone, ' +
          'silently: you message the owner only if there is something worth telling. Your routines that are on are listed ' +
          'in your instructions with their ids. When the owner asks for something repeated or for a reminder, set it up; ' +
          'when you notice work that could repeat, offer the owner a routine and create it only once they agree, never ' +
          `unasked. At most ${maxRoutinesPerBot} routines. Changes are reviewed, and the owner sees each one in your chat.\n` +
          '- create: a new routine (a name, a prompt, a schedule).\n' +
          '- update: change a routine\'s name, prompt or schedule by its routineId.\n' +
          '- pause, resume: stop a routine firing, or start it again, by its routineId.\n' +
          '- delete: delete a routine and its history for good by its routineId.',
        parameters: Type.Object({
          target: Type.Union([Type.Literal('memory'), Type.Literal('routine')]),
          action: Type.Union(
            ['write', 'edit', 'forget', 'create', 'update', 'pause', 'resume', 'delete'].map((action) => Type.Literal(action)),
            { description: 'memory: write, edit or forget. routine: create, update, pause, resume or delete' },
          ),
          scope: Type.Optional(
            Type.Union([Type.Literal('bot'), Type.Literal('shared')], {
              description: 'memory write: whose memory; "bot", your own, or "shared", every bot\'s. edit, forget: leave it out, the fact\'s own is used',
            }),
          ),
          tier: Type.Optional(
            Type.Union(
              factTiers.map((tier) => Type.Literal(tier)),
              {
                description:
                  'memory write, edit: profile for what is always true and always relevant; log for a dated event, which fades but is kept; ' +
                  'note for what matters only for about a week',
              },
            ),
          ),
          text: Type.Optional(Type.String({ description: `memory write, edit: the fact, one statement, at most ${maxFactLength} characters`, maxLength: maxFactLength })),
          importance: Type.Optional(
            Type.Integer({
              description: `memory write, edit: from ${minImportance} (trivia) to ${maxImportance} (essential); ${defaultImportance} by default`,
              minimum: minImportance,
              maximum: maxImportance,
            }),
          ),
          id: Type.Optional(Type.Integer({ description: 'memory edit, forget: the fact\'s id, as in [12]' })),
          routineId: Type.Optional(Type.String({ description: 'routine update, pause, resume, delete: the routine\'s id, as in brackets in your instructions' })),
          name: Type.Optional(Type.String({ description: `routine create, update: a short name, e.g. "Morning digest"; at most ${maxRoutineNameLength} characters` })),
          prompt: Type.Optional(
            Type.String({
              description: 'routine create, update: the instruction you read when it wakes you, e.g. "Send the owner a digest of the night\'s build failures."',
            }),
          ),
          schedule: Type.Optional(
            Type.String({
              description:
                'routine create, update: in the owner\'s time zone, one of a 5-field cron expression ("0 8 * * 1-5" every weekday at 08:00), ' +
                '@hourly, @daily, @weekly, @monthly, @yearly, "@every <n>m|h|d" (at least 5 minutes), or a one-off reminder ' +
                '"at YYYY-MM-DDTHH:MM" (e.g. "at 2026-10-29T09:00")',
            }),
          ),
        }),
        // Replaying a write or a create would make it twice; a change already done might answer "no such fact".
        replay: 'unsafe',
        execute: async (args, api) => {
          const bot = await botOf(api.conversationId)
          const answer = (text: string) => ({ output: [{ type: 'text' as const, text }] })
          if (args.target === 'routine') return answer(await changeRoutine(bot, args, `${api.conversationId}:${api.callId}`))
          const now = runtime!.#clock.now()
          if (args.action === 'write') {
            if (!args.scope) throw new Error('Say whose memory to write to: scope "bot" (yours) or "shared" (every bot\'s).')
            if (!args.tier || args.text === undefined) throw new Error('A new fact needs a tier and a text.')
            const fact = await writeFact(options.db, bot, { scope: args.scope, tier: args.tier, text: args.text, importance: args.importance }, now)
            return answer(`Saved as [${fact.id}].`)
          }
          if (args.action !== 'edit' && args.action !== 'forget') throw new Error('target "memory" takes action write, edit or forget.')
          if (args.id === undefined) throw new Error(`Say which fact to ${args.action} by its id.`)
          if (args.action === 'edit') {
            const fact = await editFact(options.db, { botId: bot.id, scope: args.scope }, args.id, { text: args.text, tier: args.tier, importance: args.importance }, now)
            return answer(`Updated [${fact.id}].`)
          }
          await forgetFact(options.db, { botId: bot.id, scope: args.scope }, args.id)
          return answer(`Forgot [${args.id}].`)
        },
      }),
    }
    /**
     * Makes the bot's change to one of its own routines, answers what the tool says, and posts the change's timeline row
     * in its DM. A routine of another bot answers as a missing one does.
     */
    const changeRoutine = async (
      bot: BotWithChat,
      args: { action: string; routineId?: string; name?: string; prompt?: string; schedule?: string },
      idempotencyKey: string,
    ): Promise<string> => {
      const { routines } = options
      const timeZone = await ownerTimeZone(options.db)
      const nextRun = (routine: RoutineState) => (routine.nextRunAt ? `; next run ${localTime(routine.nextRunAt.getTime(), timeZone)} (${timeZone})` : '')
      const posted = async (change: RoutineChangeKind, routine: { id: string; name: string }) =>
        options.postRoutineChange(bot, { type: 'routine_change', change, routineId: routine.id, name: routine.name }, idempotencyKey)
      try {
        if (args.action === 'create') {
          if (args.name === undefined || args.prompt === undefined || args.schedule === undefined) throw new Error('A new routine needs a name, a prompt and a schedule.')
          const routine = await routines.create(bot.id, { name: args.name, prompt: args.prompt, schedule: args.schedule }, 'bot')
          await posted('created', routine)
          return `Created routine [${routine.id}] ${JSON.stringify(routine.name)}${nextRun(routine)}.`
        }
        if (!['update', 'pause', 'resume', 'delete'].includes(args.action)) throw new Error('target "routine" takes action create, update, pause, resume or delete.')
        if (args.routineId === undefined) throw new Error(`Say which routine to ${args.action} by its routineId.`)
        if (args.action === 'update') {
          const changes = { name: args.name, prompt: args.prompt, schedule: args.schedule }
          if (Object.values(changes).every((value) => value === undefined)) throw new Error("Say what to change: the routine's name, prompt or schedule.")
          const routine = await routines.update(bot.id, args.routineId, changes, 'bot')
          await posted('updated', routine)
          return `Updated routine [${routine.id}]${nextRun(routine)}.`
        }
        // Already so: nothing changes, and nothing is posted.
        if ((args.action === 'pause' || args.action === 'resume') && (await routines.get(bot.id, args.routineId)).enabled === (args.action === 'resume')) {
          return `Routine [${args.routineId}] is already ${args.action === 'pause' ? 'paused' : 'on'}.`
        }
        if (args.action === 'pause') {
          const routine = await routines.pause(bot.id, args.routineId, 'bot')
          await posted('paused', routine)
          return `Paused routine [${routine.id}].`
        }
        if (args.action === 'resume') {
          const routine = await routines.resume(bot.id, args.routineId, 'bot')
          await posted('resumed', routine)
          return `Resumed routine [${routine.id}]${nextRun(routine)}.`
        }
        const routine = await routines.delete(bot.id, args.routineId, 'bot')
        await posted('deleted', routine)
        return `Deleted routine [${routine.id}].`
      } catch (error) {
        if (error instanceof NoSuchRoutineError) throw new Error(`There is no routine [${args.routineId}] of yours.`)
        if (error instanceof InvalidRoutineError) throw new Error(error.message)
        throw error
      }
    }
    // A computer-use session is reviewed, and logged with its reason, as a whole; its browser and desktop tools are not
    // one by one.
    const useComputer: BotTool = { surface: 'computer_session', tool: computerUseSessions.useComputer }
    /**
     * Every call of a bot's tool gives up once the watchdog detaches its run: the call ignored the run's abort, which
     * waits for it, and the bot's history can only go on once it has ended.
     */
    const detachable = ({ surface, tool }: BotTool): BotTool => ({
      surface,
      tool: {
        ...tool,
        execute: async (args, api, ctx) => {
          const detached = runtime!.#scheduler.detached((await botOf(api.conversationId)).id).then(() => {
            throw new Error('Abandoned: the call ignored an interrupt')
          })
          return Promise.race([tool.execute(args, api, ctx), detached])
        },
      },
    })
    const tools = [sendMessage, messageBot, askQuestion, searchPlugins, requestPlugin, updateState, ...computerTools(images), useComputer, ...(options.tools ?? [])].map(detachable)
    /** The audit entries of reviewed calls that are running, by conversation and call, and when each started. */
    const reviewed = new Map<string, { entryId: string; started: number }>()
    const toolSurfaces = new Map<string, ToolSurface>([
      ...tools.map(({ surface, tool }) => [tool.name, surface] as const),
      // Sessions don't select this extension, so its hooks shouldn't see their browser and desktop tools; if they ever
      // do, those calls were covered by the session's review.
      ...computerUseSessions.sessionToolNames.map((name) => [name, null] as const),
      [TOOL_SEARCH_TOOL_NAME, null],
    ])
    const bots = defineExtension({
      name: 'openbot',
      sections: [section('voice', () => voice, { tag: false })],
      tools: tools.map(({ tool }) => tool),
      hooks: [
        hook(GenerationTask, { onYield: (_answer, api) => runtime?.remindIfOwed(api.conversationId) }),
        // The owner's newer message is about to supersede the run; until then the bot can't answer the request it replaces.
        hook(ToolTask, {
          beforeTool: async (call, api) => {
            if (!ownerTools.has(call.name)) return
            return runtime!.#scheduler.superseded((await botOf(api.conversationId)).id) ? { block: outdatedAnswer } : undefined
          },
        }),
        // The orchestrator hook: every call of a tool with a side effect is reviewed before it runs. It stays last, so
        // it reviews the arguments the call will run with, and no other hook may rewrite arguments after it.
        hook(ToolTask, {
          beforeTool: async (call, api) => {
            let declared = toolSurfaces.get(call.name)
            if (declared === null) return
            const bot = await botOf(api.conversationId)
            let server: string | undefined
            if (!toolSurfaces.has(call.name)) {
              // One of the bot's own tools, checked against those it has now: one it lost since loading it fails cleanly.
              const own = (await options.botTools?.(bot.id))?.find(({ tool }) => tool.name === call.name)
              if (!own) return { block: lostTool(call.name) }
              declared = own.surface
              server = own.server
            }
            // Fails closed: a tool that never declared its surface can't run unreviewed.
            if (declared === undefined) return { block: `${call.name} declares no surface, so it can't be reviewed` }
            const { surface, arguments: pinned } = typeof declared === 'function' ? await declared(call.arguments, bot.id) : { surface: declared }
            const replaced = pinned && { arguments: pinned }
            if (surface === null) return replaced
            const { entryId, blocked } = await reviewAction(options.db, options.orchestrator, bot.id, {
              surface,
              tool: call.name,
              input: pinned ?? call.arguments,
              ...(server && { server }),
            })
            if (blocked) return { block: blocked }
            reviewed.set(`${api.conversationId}:${call.id}`, { entryId, started: Date.now() })
            return replaced
          },
          // How each reviewed call that ran ended goes into its audit entry.
          afterTool: async (call, result, api) => {
            const key = `${api.conversationId}:${call.id}`
            const entry = reviewed.get(key)
            if (!entry) return
            reviewed.delete(key)
            await recordOutcome(options.db, entry.entryId, { status: result.isError ? 'error' : 'ok', durationMs: Date.now() - entry.started })
          },
        }),
      ],
    })
    // Bots' histories select only their own extension; the browser and desktop tools are only in computer-use sessions
    // (ADR 0008).
    const toolSearch = createToolSearchExtension()
    registry.install(bots)
    registry.install(toolSearch)
    registry.install(computerUseSessions.extension)
    const actingTools = new Set([...toolSurfaces].flatMap(([name, surface]) => (typeof surface === 'string' ? [name] : [])))
    /** The names of each bot's own tools that act. */
    const ownActing = new Map<string, Set<string>>()
    const ownTools: OwnTools = {
      install: async (botId) => {
        let own: BotTool[]
        try {
          own = ((await options.botTools?.(botId)) ?? []).map(({ surface, tool }) => detachable({ surface, tool: { ...tool, deferred: true } }))
        } catch (error) {
          console.error(`[agent] Couldn't read bot ${botId}'s own tools:`, error)
          return undefined
        }
        ownActing.set(botId, new Set(own.flatMap(({ surface, tool }) => (typeof surface === 'string' ? [tool.name] : []))))
        if (!own.length) {
          registry.uninstall({ name: ownToolsExtension(botId) })
          return null
        }
        const extension = defineExtension({ name: ownToolsExtension(botId), tools: own.map(({ tool }) => tool) })
        registry.install(extension)
        return [bots, toolSearch, extension]
      },
      acts: (botId, name) => ownActing.get(botId)?.has(name) ?? false,
      forget: (botId) => {
        ownActing.delete(botId)
        registry.uninstall({ name: ownToolsExtension(botId) })
      },
    }
    const storage: Storage = options.storagePath ? await openNodeSqliteStorage(options.storagePath) : new MemoryStorage()
    harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry,
        settings: { extensions: [bots], ...(options.compaction && { compaction: options.compaction }) },
        // Each tool call runs in its bot's environment on the computer.
        env: async ({ conversationId }) => options.computer.env(await botOf(conversationId)),
        onReport: (error) => console.error('[agent]', error),
      },
      context,
    )
    runtime = new BotRuntime(harness, options, images, actingTools, ownTools)
    // Before pi-durable resumes runs, which may call them.
    for (const bot of await listBots(options.db)) await ownTools.install(bot.id)
    // Read before pi-durable resumes runs, whose replayed calls may queue inputs: those are woken as they are queued.
    await pruneTakenInputs(options.db)
    const queued = await queuedInputs(options.db)
    const resuming = await runtime.#resumingRuns()
    harness.resume()
    // At once, so no replayed call wakes a bot first. The runs pi-durable resumes are the bots' runs going on, which the
    // queued inputs, back in the order they were queued and sorted by lane, wait for or interrupt.
    for (const { botId, inputs, run } of resuming) runtime.#scheduler.adopt(botId, inputs, run)
    for (const { botId, input } of queued) runtime.#scheduler.wake(botId, input)
    for (const botId of await botsOwingReplies(options.db)) void runtime.#redriveReply(botId)
    return runtime
  }

  /**
   * The runs of bots' histories pi-durable is about to resume, with the inputs they were for (see `RunScheduler.adopt`).
   * Those kept are read back, so an interrupt queues them again; of the others, only the lane and id are known, so they
   * run once. Read before pi-durable resumes them.
   */
  async #resumingRuns(): Promise<{ botId: string; inputs: QueuedInput[]; run: Run }[]> {
    const runs = []
    for (const bot of await listBots(this.#options.db)) {
      const history = bot.historyId ? await this.#harness.conversation(toConversationId(bot.historyId), context) : undefined
      if (!history) continue
      const submissionIds = await history.commit(async (tx) => [...((await tx.doc(LiveDoc, history.id)).run?.inputs ?? [])], context)
      if (!submissionIds.length) continue
      const submissions = () => Promise.all(submissionIds.map(async (id) => (await this.#harness.submission(id, context))?.status(context)))
      const requestId = (await submissions()).find((submission) => submission?.requestId)?.requestId
      const record = await this.inputOf(history.id)
      const inputs = await Promise.all(
        (requestId ? inputIdsOf(requestId) : [record?.id]).map(
          async (id): Promise<QueuedInput> =>
            (id && (await keptInput(this.#options.db, bot.id, id))) || {
              lane: record?.lane ?? 'owner',
              text: '',
              ...(id && { id }),
              ...(record?.groupChatId && { groupChatId: record.groupChatId }),
              runsOnce: true,
            },
        ),
      )
      const statuses = async () => (await submissions()).map((submission) => submission?.status)
      runs.push({
        botId: bot.id,
        inputs,
        run: {
          ended: async () => (await statuses()).every((status) => status === 'done' || status === 'unanswered'),
          answered: async () => (await statuses()).every((status) => status === 'done'),
        },
      })
    }
    return runs
  }

  /**
   * Wakes a bot that owes the owner a reply as the server starts, once any run pi-durable resumed has ended: that run
   * may reply yet. It reads `owedReplyNote`, then the owner's messages since its last reply.
   */
  async #redriveReply(botId: string) {
    try {
      await (await this.#existingHistory(botId))?.waitForIdle(context)
      const bot = await getBot(this.#options.db, botId)
      if (!bot || !(await redriveReply(this.#options.db, botId))) return
      const unanswered = await sinceLastReply(this.#options.db, bot.chatId)
      await this.wake(botId, {
        lane: 'owner',
        text: [owedReplyNote, ...unanswered.map((message) => message.text)].filter(Boolean).join('\n\n'),
        attachments: unanswered.flatMap((message) => message.attachments),
        id: `owed-reply:${randomUUID()}`,
      })
    } catch (error) {
      console.error(`[agent] Couldn't wake bot ${botId} for the reply it owes the owner:`, error)
    }
  }

  /**
   * Leaves `text` in the bot's history for its model to read, without waking it: at once when it is idle, otherwise
   * after its current tool round. A bot without a history yet has nothing to be told.
   */
  async note(botId: string, text: string): Promise<void> {
    const history = await this.#existingHistory(botId)
    if (!history) return
    await history.submit({ type: 'write', entry: { kind: noteKind, data: { text }, model: [{ role: 'user', content: text, timestamp: Date.now() }] } }, context)
  }

  /** Queues `input` (see `AgentRuntime.wake` and `RunScheduler`). */
  async wake(botId: string, input: BotInput): Promise<void> {
    await this.#wake(botId, input)
  }

  async takeTurn(botId: string, input: BotInput): Promise<void> {
    let settle!: () => void
    const ended = new Promise<void>((resolve) => (settle = resolve))
    if (!(await this.#wake(botId, { ...input, settle }))) return
    await ended
  }

  /**
   * Queues `input`, kept in the database across restarts unless it is a group chat's turn; false when it was queued
   * before, here or before a restart.
   */
  async #wake(botId: string, input: QueuedInput): Promise<boolean> {
    const bot = await getBot(this.#options.db, botId)
    if (!bot) throw new Error(`Unknown bot ${botId}`)
    await this.#model(bot)
    this.#errors.delete(botId)
    if (!isKept(input)) return this.#scheduler.wake(botId, input)
    const queued = { ...input, id: input.id ?? randomUUID() }
    if (!(await keepInput(this.#options.db, botId, toKept(queued)))) return false
    return this.#scheduler.wake(botId, queued)
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
   * Claims text `text` for call `callId` of the bot's run `inputId`: false when another call of the run already sent
   * it. Returns a function taking the claim back if the message isn't sent.
   */
  claimText(botId: string, inputId: string, text: string, callId: string): (() => void) | false {
    const run = this.#sentTexts.get(botId)
    const current = run?.inputId === inputId ? run : { inputId, calls: new Map<string, string>() }
    const key = text.trim()
    const sender = current.calls.get(key)
    if (sender !== undefined && sender !== callId) return false
    current.calls.set(key, callId)
    this.#sentTexts.set(botId, current)
    return () => {
      if (current.calls.get(key) === callId) current.calls.delete(key)
    }
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

  async endGroupTurns(groupChatId: string): Promise<void> {
    await this.#scheduler.endGroup(groupChatId)
  }

  async forget({ id, name, historyId }: { id: string; name: string; historyId: string | null }): Promise<void> {
    this.#scheduler.forget(id)
    this.#ownTools.forget(id)
    if (historyId) await (await this.#harness.conversation(toConversationId(historyId), context))?.abort(context)
    try {
      await this.#options.computer.removeFolder({ id, name })
    } catch (error) {
      // The bot is gone either way; a folder left behind is only clutter.
      console.error(`[agent] Couldn't delete ${name}'s folder:`, error)
    }
    // pi-durable can't delete a conversation, so the history stays in its storage with no bot to reach it.
    this.#histories.delete(id)
    this.#errors.delete(id)
    this.#groupMessages.delete(id)
  }

  /**
   * Compacts the bot's history now, as pi-durable does once it nears the model's context window: older entries are
   * summarized on the bot's model, beginning a new compaction epoch. Resolves once the summary is in place (at once
   * when the bot is idle, otherwise at its run's next boundary); does nothing for a bot without a history yet.
   */
  async compact(botId: string): Promise<void> {
    const history = await this.#existingHistory(botId)
    if (!history) return
    const { outcome } = (await this.#harness.waitForTask(await history.compact(undefined, context), context)).state
    if (outcome.status !== 'completed') throw new Error(`Couldn't compact bot ${botId}'s history: ${outcome.error?.message ?? outcome.status}`)
    if (outcome.result.submissionId !== undefined) await (await this.#harness.submission(outcome.result.submissionId, context))?.wait(context)
  }

  /**
   * The bot's compaction epoch: the entry its current context starts from, the newest compaction (or reset) of its
   * history; null before the first. Whatever is frozen per epoch, e.g. the memory block, is rendered anew once it changes.
   */
  async compactionEpoch(botId: string): Promise<string | null> {
    const head = (await (await this.#existingHistory(botId))?.context(context))?.head
    return head ? String(head.id) : null
  }

  /** Whether the bot's input `inputId` is queued or running, e.g. a routine's previous run. */
  pending(botId: string, inputId: string): boolean {
    return this.#scheduler.pending(botId, inputId)
  }

  status(botId: string): BotStatus {
    return { working: this.#scheduler.working(botId), error: this.#errors.get(botId) ?? null }
  }

  async close(): Promise<void> {
    this.#closing = true
    this.#scheduler.close()
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

  /**
   * What the model reads of a run's inputs, one after the other, after a note when they interrupted the bot (see
   * `RunScheduler`) and the `reminder` of unanswered questions.
   */
  async #contents(bot: BotWithChat, inputs: QueuedInput[], reminder?: string): Promise<string | (TextContent | ImageContent)[]> {
    const note = inputs.some((input) => input.supersedes) ? supersededNote : inputs.some((input) => input.attempt) ? interruptedNote : undefined
    const contents = await Promise.all(inputs.map((input) => this.#content(bot, input)))
    if (reminder) contents.unshift(reminder)
    if (note) contents.unshift(note)
    if (contents.every((content) => typeof content === 'string')) return contents.join('\n\n')
    return contents.flatMap((content) => (typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content))
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

  /** The bot's history, if it has one yet. */
  async #existingHistory(botId: string): Promise<Conversation | undefined> {
    const pending = this.#histories.get(botId)
    if (pending) return pending.catch(() => undefined)
    const bot = await getBot(this.#options.db, botId)
    return bot?.historyId ? this.#harness.conversation(toConversationId(bot.historyId), context) : undefined
  }

  /**
   * Configures the bot's history as the bot is now and submits `inputs` as one run (see `RunScheduler`). A run in the
   * bot's DM begins with the questions the owner left unanswered, each listed once. The run of a deleted bot has
   * nothing to do.
   */
  async #submit(botId: string, inputs: QueuedInput[]): Promise<Run> {
    const bot = await getBot(this.#options.db, botId)
    const [first] = inputs as [QueuedInput]
    // A turn in a group chat deleted while it waited, e.g. queued by rounds that were ending, has nothing to do either.
    if (!bot || (first.groupChatId && !(await getGroup(this.#options.db, first.groupChatId)))) return { ended: async () => true, answered: async () => true }
    if (this.#options.computer.unavailable) throw new ComputerUnavailableError(this.#options.computer.unavailable)
    const history = await this.#history(bot)
    const others = (await listBots(this.#options.db)).filter((other) => other.id !== bot.id)
    const groups = await listGroups(this.#options.db, bot.id)
    // Last, so what comes before them stays cached when a new compaction epoch renders them anew.
    const epoch = await this.compactionEpoch(bot.id)
    const timeZone = await ownerTimeZone(this.#options.db)
    const routines = await frozenRoutinesBlock(this.#options.db, bot.id, epoch, { timeZone })
    const memory = await frozenMemoryBlock(this.#options.db, bot.id, epoch, { now: this.#clock.now(), timeZone })
    const skills = await frozenSkillsBlock(this.#options.db, bot.id, epoch, async () => (await this.#options.botSkills?.(bot.id)) ?? [])
    const owner = ownerPrompt(await readOwnerProfile(this.#options.db))
    const instructions = [botPrompt(bot), owner, computerPrompt(this.#options.computer, bot, others), teamPrompt(others), groupsPrompt(bot, groups), skills, routines, memory]
      .filter(Boolean)
      .join('\n\n')
    const extensions = await this.#ownTools.install(bot.id)
    await history.configure({ model: await this.#model(bot), instructions, extensions }, context)
    // A detached run is still ending: an input queued behind it now would wait in pi's inbox once it has.
    await history.waitForIdle(context)
    const unanswered = first.groupChatId ? [] : await unansweredQuestions(this.#options.db, bot.chatId)
    const reminder = unanswered.length ? describeUnanswered(unanswered.map((question) => question.prompt)) : undefined
    const submission = await history.submit(
      {
        type: 'input',
        content: await this.#contents(bot, inputs, reminder),
        requestId: requestIdOf(inputs),
        entry: {
          kind: inputKind,
          data: { lane: first.lane, ...(first.groupChatId && { groupChatId: first.groupChatId }), ...(first.id && { id: first.id }) } satisfies InputRecord,
        },
      },
      context,
    )
    await markReminded(this.#options.db, unanswered.map((question) => question.id))
    void this.#settled(bot.id, inputs, submission)
    const status = async () => (await submission.status(context)).status
    return {
      ended: async () => ['done', 'unanswered'].includes(await status()),
      answered: async () => (await status()) === 'done',
      failure: async () => {
        const record = await submission.status(context)
        return record.status === 'unanswered' ? describeFailure(record) : undefined
      },
    }
  }

  /**
   * Once the run of `inputs` has settled: reports it failed when it ended without answering, other than by an interrupt
   * (the model or its provider errored), and tells `onRunSettled` if its input made it into the history.
   */
  async #settled(botId: string, inputs: readonly QueuedInput[], submission: Submission) {
    let settled
    try {
      settled = await submission.wait(context)
    } catch {
      return // The Harness closed.
    }
    if (settled.entry !== undefined) {
      const entry = settled.entry
      this.#options.onRunSettled?.(botId, () => this.#exchange(botId, inputs, entry))
    }
    if (settled.status !== 'unanswered' || settled.reason === 'aborted') return
    const error = describeFailure(settled)
    console.error(`[agent] Bot ${botId}'s run failed: ${error}`)
    this.#errors.set(botId, error)
    this.#options.onStatus(botId, this.status(botId))
  }

  /**
   * The run of `inputs`, whose input is entry `inputEntry` of the bot's history, as extraction reads it: the owner's DM
   * messages are the owner's words, and what the bot sent with sendMessage, message_bot or askQuestion its own
   * messages; everything else (other inputs, tool calls and results, its private text) is context.
   */
  async #exchange(botId: string, inputs: readonly QueuedInput[], inputEntry: EntryId): Promise<RunExchange | undefined> {
    const history = await this.#existingHistory(botId)
    if (!history) return undefined
    const parts: ExchangePart[] = inputs
      .filter((input) => input.text.trim())
      .map((input) =>
        isOwnerDmInput(input)
          ? { from: 'owner', text: input.text }
          : { from: 'context', kind: 'input', label: describeInputSource(input), text: input.text },
      )
    let cursor
    do {
      const page = await history.entries({ minEntryId: inputEntry, order: 'ascending' }, 100, cursor, context)
      for (const entry of page.items) {
        if (entry.id === inputEntry || isReminder(entry)) continue
        // The next run's.
        if (entry.kind === inputKind) return parts
        for (const message of entry.model ?? []) {
          if (message.role === 'assistant') {
            for (const block of message.content) {
              if (block.type === 'text' && block.text.trim()) parts.push({ from: 'context', kind: 'thought', label: 'your private text', text: block.text })
              if (block.type === 'toolCall') parts.push(sentOrCalled(block.name, block.arguments, (name) => this.#actingTools.has(name) || this.#ownTools.acts(botId, name)))
            }
          }
          if (message.role === 'toolResult' && !sendingTools.has(message.toolName)) {
            const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : ['(an image)'])).join('\n')
            parts.push({ from: 'context', kind: 'tool_result', label: `result of ${message.toolName}`, text })
          }
        }
      }
      cursor = page.next
    } while (cursor)
    return parts
  }
}
