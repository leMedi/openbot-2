import { createORPCClient } from '@orpc/client'
import { type ContractRouterClient, eventIterator, oc } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { z } from 'zod'

export const avatarShapes = ['blob', 'pebble', 'squircle', 'tablet', 'wedge', 'hex', 'cloud', 'teardrop'] as const
export const avatarColors = [
  'black',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray',
] as const

export const bot = z.object({
  id: z.string(),
  /** Unique, ignoring case; how the owner and other bots mention the bot. */
  name: z.string(),
  title: z.string().nullable(),
  /** The owner's instructions: who the bot is and how it behaves. */
  instructions: z.string(),
  avatarShape: z.enum(avatarShapes),
  avatarColor: z.enum(avatarColors),
  /** `provider/modelId`; null follows the default model. */
  model: z.string().nullable(),
  /** The bot's DM. */
  chatId: z.string(),
  /** A run is going: the bot is thinking, using tools or writing. */
  working: z.boolean(),
  /** Why the bot's latest run failed, e.g. its provider rejected the request; null once a later run starts. */
  error: z.string().nullable(),
})
export type BotInfo = z.infer<typeof bot>

export const newBot = z.object({
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().max(120).nullable(),
  instructions: z.string().max(20_000),
  avatarShape: z.enum(avatarShapes),
  avatarColor: z.enum(avatarColors),
  model: z.string().nullable(),
})
export type NewBot = z.infer<typeof newBot>

/** Profile fields to change; the rest stay. A null `model` follows the default model again. */
export const botChanges = newBot.partial()
export type BotChanges = z.infer<typeof botChanges>

export const questionOptionStyles = ['default', 'primary', 'danger'] as const

/** One choice on a question card. */
export const questionOption = z.object({
  label: z.string(),
  description: z.string().nullable(),
  style: z.enum(questionOptionStyles),
})
export type QuestionOptionInfo = z.infer<typeof questionOption>

/** The owner's answer to a question card: one of its options, by index, or their own words when the card allows it. */
export const questionAnswer = z.union([
  z.object({ option: z.number().int().nonnegative() }),
  z.object({ text: z.string().trim().min(1).max(10_000) }),
])
export type QuestionAnswer = z.infer<typeof questionAnswer>

/** A bot asking the owner to decide: 1–6 options and, when `allowText`, a free-text answer. */
export const questionCard = z.object({
  type: z.literal('question'),
  prompt: z.string(),
  /** Help text under the prompt. */
  details: z.string().nullable(),
  options: z.array(questionOption).min(1).max(6),
  allowText: z.boolean(),
  /** Null while open; once answered, the card can't be answered again. */
  answer: questionAnswer.nullable(),
  /** The owner dismissed the card unanswered, or it was dismissed when they moved on; it can't be answered any more. */
  dismissed: z.boolean(),
})
export type QuestionCardInfo = z.infer<typeof questionCard>

/** How the owner handed a bot's screen back: they did the step, or skipped it without doing it. */
export const handBackOutcomes = ['done', 'skipped'] as const
export const handBackOutcome = z.enum(handBackOutcomes)
export type HandBackOutcome = z.infer<typeof handBackOutcome>

/**
 * A bot stuck on its screen on something only the owner can do (a login, a captcha, two-factor, a payment): they take
 * the screen over, then hand it back, which wakes the bot.
 */
export const takeOverCard = z.object({
  type: z.literal('take_over'),
  /** One line telling the owner what to do on the screen. */
  instruction: z.string(),
  /** Null while it waits for the owner; once handed back, it can't be handed back again. */
  outcome: handBackOutcome.nullable(),
})
export type TakeOverCardInfo = z.infer<typeof takeOverCard>

/** What a bot did to one of its own routines. */
export const routineChangeKinds = ['created', 'updated', 'paused', 'resumed', 'deleted'] as const

/**
 * A timeline row in a bot's DM: the bot created, changed, paused, resumed or deleted one of its routines. The message's
 * text says so ("Rex created routine *Morning digest*"); its clock chip opens the routine in the Routines pane.
 */
export const routineChangeCard = z.object({
  type: z.literal('routine_change'),
  change: z.enum(routineChangeKinds),
  routineId: z.string(),
  /** The routine's name when changed. */
  name: z.string(),
})
export type RoutineChangeCardInfo = z.infer<typeof routineChangeCard>

/** An item in a chat that isn't a plain message: a card that asks the owner for something, or a timeline row. */
export const card = z.discriminatedUnion('type', [questionCard, takeOverCard, routineChangeCard])
export type CardInfo = z.infer<typeof card>

/** At most this many files go with one message (Grok's composer limit); the server enforces the same. */
export const maxAttachments = 6
/** The largest file a message can carry, either way. */
export const maxAttachmentBytes = 50 * 1024 * 1024

/** A file posted with a message, on the computer at `path`; the owner downloads the copy posted with the message. */
export const attachment = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  /** Bytes. */
  size: z.number(),
  /** Where it is on the computer: the bot's uploads folder for the owner's files, wherever the bot had it for its own. */
  path: z.string(),
})
export type AttachmentInfo = z.infer<typeof attachment>

/** Where the owner downloads an attachment from, under the API's URL. */
export const attachmentPath = (messageId: string, attachmentId: string) => `/messages/${messageId}/attachments/${attachmentId}`

/**
 * A message between two bots, as it shows in one of their DMs: sent `to` the other bot (in the sender's DM) or received
 * `from` it (in the recipient's).
 */
export const botMessage = z.object({
  direction: z.enum(['to', 'from']),
  /** The other bot; null once it is deleted. */
  botId: z.string().nullable(),
  /** The other bot's name when sent, with " (deleted)" once it is deleted. */
  name: z.string(),
})
export type BotMessageInfo = z.infer<typeof botMessage>

/** Something the owner or a bot posted in a chat. A bot's thinking and tool use are never messages. */
export const message = z.object({
  id: z.string(),
  chatId: z.string(),
  author: z.enum(['owner', 'bot']),
  /** The bot that posted it, when `author` is `bot`; null once that bot is deleted. */
  botId: z.string().nullable(),
  /** The author's name when it posted, with " (deleted)" once its bot is deleted. */
  authorName: z.string(),
  /** Markdown; may be empty when the message carries files. A card's message holds its prompt. */
  text: z.string(),
  /** Files that came with the message, in the order they were attached. */
  attachments: z.array(attachment),
  /** Set when the message is a card. */
  card: card.nullable(),
  /** Set when one bot sent the message to another; it then shows in both bots' DMs. */
  botMessage: botMessage.nullable(),
  /** Milliseconds since the epoch. */
  createdAt: z.number(),
})
export type MessageInfo = z.infer<typeof message>

/** How a message's author shows once its bot is deleted (ADR 0009). */
export const deletedAuthorName = (name: string) => `${name} (deleted)`

/** What the sidebar shows of a chat: where it sits, and whether the owner should look at it. */
export const chat = z.object({
  id: z.string(),
  kind: z.enum(['dm', 'group']),
  /** The DM's bot; null for group chats. */
  botId: z.string().nullable(),
  /** A group chat's name: its title, or its members' names until renamed; null for a DM. */
  name: z.string().nullable(),
  /** A group chat's title, as the owner named it; null when named after its members, and for a DM. */
  title: z.string().nullable(),
  /** A group chat's member bots, in their turn order; empty for a DM. */
  members: z.array(z.string()),
  /** The member taking its turn in a group chat now; null between turns, and for a DM. */
  speaking: z.string().nullable(),
  /** Place among pinned chats, 0 first; null when not pinned. Pinned chats sit above the rest. */
  pinnedPosition: z.number().int().nonnegative().nullable(),
  /** A bot posted since the owner last opened the chat. */
  unread: z.boolean(),
  /**
   * The prompt of the newest question card still open (neither answered nor dismissed), or the instruction of a
   * take-over card still waiting: the chat needs the owner. Null when nothing waits.
   */
  waitingFor: z.string().nullable(),
  /** The newest message, for the sidebar's preview line; null when the chat is empty. */
  lastMessage: message.pick({ author: true, authorName: true, text: true, attachments: true, botMessage: true, createdAt: true }).nullable(),
})
export type ChatInfo = z.infer<typeof chat>

/** A group chat is the owner and at least this many bots (the server enforces the same)... */
export const minGroupMembers = 2
/** ...and at most this many: Grok's cap. */
export const maxGroupMembers = 6
/** Member bot ids; the server says when there are too few or too many. */
const groupMembers = z.array(z.string()).max(100)

/** A group chat's name as the owner sets it; blank names it after its members again. */
const groupTitle = z.string().trim().max(120).nullable()

export const onboarding = z.object({
  provider: z.boolean(),
  defaultModel: z.boolean(),
  bot: z.boolean(),
  /** Every step is done; until then the web app shows onboarding. */
  done: z.boolean(),
})
export type Onboarding = z.infer<typeof onboarding>

/** An IANA time zone, e.g. `Europe/Paris`. */
const timeZone = z.string().min(1)

/**
 * A bot's routine (design §5.4): a prompt and a schedule that wake the bot in its background lane. `schedule` is a
 * 5-field cron expression, an alias (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`), `@every <n>m|h|d` (at
 * least 5 minutes), or a reminder's `at YYYY-MM-DDTHH:MM`, all in the owner's time zone.
 */
export const routine = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  /** The instruction the bot reads when it fires. */
  prompt: z.string(),
  schedule: z.string(),
  /** False while paused, and for a reminder that fired. */
  enabled: z.boolean(),
  /** When it fires next, in ms since the epoch; null while disabled. */
  nextRunAt: z.number().nullable(),
  /** Who created it or last edited it: the owner's routines speak for the owner, the bot's are its own notes. */
  createdBy: z.enum(['owner', 'bot']),
  /** Its latest run is queued or running. */
  running: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type RoutineInfo = z.infer<typeof routine>

export const routineRunStatuses = ['running', 'ran', 'skipped_overlap', 'missed', 'failed'] as const

/** One run in a routine's history; the last 100 are kept. */
export const routineRun = z.object({
  id: z.number().int(),
  routineId: z.string(),
  /** When it was due (for a test run, when the owner started it), in ms since the epoch. */
  scheduledFor: z.number(),
  /** When it woke the bot; null when skipped or missed. */
  firedAt: z.number().nullable(),
  /** `running` while queued or running; `skipped_overlap` when the previous run was still going; `missed` while the server was down. */
  status: z.enum(routineRunStatuses),
  /** When it ended, or was recorded as skipped or missed; null while running. */
  finishedAt: z.number().nullable(),
  /** The first message the bot sent the owner in its DM during the run, in `chatId`; null when it stayed silent. */
  message: z.object({ id: z.string(), chatId: z.string() }).nullable(),
  /** Started by the owner's Test run. */
  test: z.boolean(),
})
export type RoutineRunInfo = z.infer<typeof routineRun>

/** A routine the owner creates: enabled unless said otherwise. */
export const newRoutine = z.object({
  name: z.string(),
  prompt: z.string(),
  schedule: z.string(),
  enabled: z.boolean().optional(),
})
export type NewRoutine = z.infer<typeof newRoutine>

/** What the owner changes of a routine; editing a bot's routine makes it the owner's. */
export const routineChanges = newRoutine.omit({ enabled: true }).partial()
export type RoutineChanges = z.infer<typeof routineChanges>

export const liveEvent = z.discriminatedUnion('type', [
  /**
   * First event of every subscription. With `resumed`, the events the client missed since the stamp it reconnected
   * with follow, and the hello carries that stamp. Otherwise (a new `epoch` after a restart, or too far behind) the
   * client must refetch; its `seq` is the last one already published, so every later event has a greater `seq`.
   */
  z.object({ type: z.literal('hello'), resumed: z.boolean() }),
  z.object({ type: z.literal('bot.created'), bot }),
  /** The bot's profile changed; `bot` is all of it as it is now. */
  z.object({ type: z.literal('bot.updated'), bot }),
  /** The bot and its DM are gone for good. */
  z.object({ type: z.literal('bot.deleted'), botId: z.string(), chatId: z.string() }),
  /** The group chat, its messages and its files are gone for good. */
  z.object({ type: z.literal('chat.deleted'), chatId: z.string() }),
  z.object({ type: z.literal('bot.status'), botId: z.string(), working: z.boolean(), error: z.string().nullable() }),
  z.object({ type: z.literal('message.created'), message }),
  /** A chat's sidebar state changed: a message, a read, a pin; `chat` is all of it as it is now. */
  z.object({ type: z.literal('chat.updated'), chat }),
  /** A message changed, e.g. the owner answered its card; `message` is all of it as it is now. */
  z.object({ type: z.literal('message.updated'), message }),
  /** The owner's time zone changed (or was first detected); scheduled jobs reschedule in it. */
  z.object({ type: z.literal('timeZone.updated'), timeZone }),
  /** A routine was created or changed, e.g. fired; `routine` is all of it as it is now. */
  z.object({ type: z.literal('routine.updated'), routine }),
  /** A routine and its runs are gone for good. */
  z.object({ type: z.literal('routine.deleted'), botId: z.string(), routineId: z.string() }),
  /** A run was recorded or changed, e.g. it ended; `run` is all of it as it is now. */
  z.object({ type: z.literal('routineRun.updated'), botId: z.string(), run: routineRun }),
])
export type LiveEvent = z.infer<typeof liveEvent>

export const stampedEvent = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  event: liveEvent,
})
export type StampedEvent = z.infer<typeof stampedEvent>

const signInMethod = z.enum(['api_key', 'oauth'])

export const provider = z.object({
  id: z.string(),
  name: z.string(),
  /** How the provider is connected, or null when it isn't. */
  connection: z.object({ method: signInMethod }).nullable(),
  methods: z.array(z.object({ method: signInMethod, label: z.string(), subscription: z.boolean() })),
})
export type ProviderInfo = z.infer<typeof provider>

/** One step of a provider sign-in, streamed to the web wizard. Never carries a credential. */
export const signInStep = z.discriminatedUnion('type', [
  /** First step; its id addresses `providers.answer`. */
  z.object({ type: z.literal('started'), signInId: z.string() }),
  z.object({
    type: z.literal('info'),
    message: z.string(),
    links: z.array(z.object({ url: z.string(), label: z.string().optional() })),
  }),
  /** Open this URL in the browser to sign in. */
  z.object({ type: z.literal('auth_url'), url: z.string(), instructions: z.string().optional() }),
  z.object({
    type: z.literal('device_code'),
    userCode: z.string(),
    verificationUri: z.string(),
    expiresInSeconds: z.number().optional(),
  }),
  z.object({ type: z.literal('progress'), message: z.string() }),
  /**
   * Needs an answer through `providers.answer`. `manual_code` asks for the URL the browser was finally redirected
   * to, which completes subscription sign-ins when OpenBot runs on another machine.
   */
  z.object({
    type: z.literal('prompt'),
    promptId: z.string(),
    kind: z.enum(['text', 'secret', 'select', 'manual_code']),
    message: z.string(),
    placeholder: z.string().optional(),
    options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })).optional(),
  }),
  /** The prompt no longer needs an answer, e.g. the sign-in callback reached the server first. */
  z.object({ type: z.literal('prompt_closed'), promptId: z.string() }),
  /** Last step on success. */
  z.object({ type: z.literal('connected') }),
  /** Last step on failure. */
  z.object({ type: z.literal('failed'), message: z.string() }),
])
export type SignInStep = z.infer<typeof signInStep>

export const model = z.object({
  /** `provider/modelId`. */
  ref: z.string(),
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  /** Accepts images, so it can be the computer-use model. */
  vision: z.boolean(),
})
export type ModelInfo = z.infer<typeof model>

/**
 * Model refs. A null computer-use model is "same as each bot's model" (its own, else the default); a null memory model
 * is "same as default"; a null default is not chosen yet.
 */
export const modelSettings = z.object({
  defaultModel: z.string().nullable(),
  computerUseModel: z.string().nullable(),
  /** Memory extraction's side calls run on it. */
  memoryModel: z.string().nullable(),
})
export type ModelSettings = z.infer<typeof modelSettings>

/** Settings → General. A null time zone is not detected yet; jobs then follow UTC. */
export const generalSettings = z.object({
  /** The owner's IANA time zone, which routines and memory consolidation follow. */
  timeZone: timeZone.nullable(),
})
export type GeneralSettings = z.infer<typeof generalSettings>

/** Kinds of side effect the orchestrator reviews. Messages between bots are not one. */
export const surfaces = [
  'shell',
  'computer_session',
  'mcp',
  'vault',
  'plugin_request',
  'routine_change',
  'memory_shared_write',
] as const
const surface = z.enum(surfaces)
/** off: not reviewed, only logged; shadow: reviewed and logged, never blocked; enforce: a deny blocks the action. */
const orchestratorMode = z.enum(['off', 'shadow', 'enforce'])

/** The mode of every surface. */
export const orchestratorModes = z.record(surface, orchestratorMode)
export type OrchestratorModes = z.infer<typeof orchestratorModes>

export const botOrchestratorModes = z.object({
  /** The bot's own modes, for some surfaces. */
  overrides: z.partialRecord(surface, orchestratorMode),
  /** The modes the bot is reviewed in: its override where it has one, else the global mode. */
  modes: orchestratorModes,
})
export type BotOrchestratorModes = z.infer<typeof botOrchestratorModes>

export const verdict = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }),
  z.object({ decision: z.literal('deny'), reason: z.string() }),
  z.object({ decision: z.literal('ask'), reason: z.string(), proposedRule: z.string().optional() }),
])

export const auditKinds = ['action', 'navigation', 'session_summary', 'extraction', 'consolidation', 'routine'] as const
export const auditKind = z.enum(auditKinds)

/**
 * One entry of a bot's audit log: a side-effecting tool call and its review (`action`), a page a computer-use session's
 * browser opened (`navigation`), a computer-use session's summary once it ended (`session_summary`), or a change memory
 * extraction made or was refused, or an extraction skipped after failing (`extraction`), or a change nightly consolidation
 * made, rejected or was refused, or a consolidation skipped after failing (`consolidation`), or a routine's run that
 * failed (`routine`).
 */
export const auditEntry = z.object({
  id: z.string(),
  botId: z.string(),
  kind: auditKind,
  surface,
  /** The tool the bot called; for a navigation, the session's tool that opened the page. */
  tool: z.string(),
  /** The tool call's input, a navigation's `{ url, title }`, or a session's summary; with secrets redacted. */
  input: z.unknown(),
  /** Null when nothing was reviewed: the surface was off, or the entry isn't an action. */
  verdict: verdict.nullable(),
  /** The surface's mode for the bot at the time. */
  mode: orchestratorMode,
  /** Milliseconds since the epoch. */
  createdAt: z.number(),
})
export type AuditEntryInfo = z.infer<typeof auditEntry>

export const factTiers = ['profile', 'log', 'note'] as const
export type FactTier = (typeof factTiers)[number]

/** One fact of a bot's memory or of shared memory, as the owner sees it in the bot's Memory pane or Settings → Shared memory. */
export const fact = z.object({
  /** Stable across edits; how the bot names it, e.g. `[12]`. */
  id: z.number().int(),
  /** `profile` (always relevant), `log` (a dated event that fades but is kept) or `note` (out of the prompt after a week). */
  tier: z.enum(factTiers),
  /** The fact itself, at most 500 characters. */
  content: z.string(),
  /** 1 to 5. */
  importance: z.number().int(),
  /** Who it was learned from: the owner or a bot. */
  source: z.enum(['owner', 'bot']),
  /** The bot it was learned from, as named when it wrote the fact, e.g. `Rex (deleted)` once deleted; null when learned from the owner. */
  sourceBotName: z.string().nullable(),
  /** When it was learned, in milliseconds since the epoch. */
  createdAt: z.number(),
  /** When it last changed, in milliseconds since the epoch. */
  updatedAt: z.number(),
})
export type FactInfo = z.infer<typeof fact>

/** A fact the owner adds; importance 3 unless given. */
export const newFact = z.object({
  tier: z.enum(factTiers),
  /** Trimmed; not empty, at most 500 characters. */
  text: z.string(),
  /** 1 to 5. */
  importance: z.number().int().optional(),
})
export type NewFact = z.infer<typeof newFact>

/** What the owner changes of a fact: any of its text, tier and importance, at least one. */
export const factChanges = newFact.partial()
export type FactChanges = z.infer<typeof factChanges>

export const screenStates = ['stopped', 'starting', 'running', 'crashed'] as const

/** A bot's screen on the computer. */
export const screen = z.object({
  /** `starting` until it is up; `crashed` while it is being restarted; `stopped` when the computer can't keep it. */
  state: z.enum(screenStates),
  width: z.number().int(),
  height: z.number().int(),
  /** When its display last (re)started, in ms since the epoch. */
  startedAt: z.number().nullable(),
})
export type ScreenInfo = z.infer<typeof screen>

/** A short-lived, single-use ticket to watch or take over a bot's screen. */
export const screenTicket = z.object({
  /** The screen's live stream: a WebSocket path on this server, ticket included. */
  url: z.string(),
  expiresAt: z.number(),
})
export type ScreenTicket = z.infer<typeof screenTicket>

export const contract = {
  health: oc
    .route({ method: 'GET', path: '/health', summary: 'Liveness, used by the installer and the updater' })
    .output(z.object({ status: z.literal('ok'), epoch: z.string(), version: z.string() })),
  events: oc
    .route({
      method: 'GET',
      path: '/events',
      summary: 'The live event stream, as server-sent events; a reconnecting client passes its last stamp to catch up',
    })
    .input(z.object({ epoch: z.string().optional(), seq: z.coerce.number().int().nonnegative().optional() }).optional())
    .output(eventIterator(stampedEvent)),
  onboarding: {
    status: oc
      .route({ method: 'GET', path: '/onboarding', summary: 'Which first-run steps are done' })
      .output(onboarding),
  },
  bots: {
    list: oc.route({ method: 'GET', path: '/bots', summary: 'Every bot, oldest first' }).output(z.array(bot)),
    create: oc
      .route({ method: 'POST', path: '/bots', summary: 'Create a bot and its DM; no other bot may have its name' })
      .input(newBot)
      .output(bot),
    update: oc
      .route({ method: 'PATCH', path: '/bots/{botId}', summary: "Change a bot's profile; no other bot may have its name" })
      .input(botChanges.extend({ botId: z.string() }))
      .output(bot),
    delete: oc
      .route({
        method: 'DELETE',
        path: '/bots/{botId}',
        summary: 'Delete a bot for good: its DM, history and everything else it owns; its messages elsewhere stay',
      })
      .input(z.object({ botId: z.string() }))
      .output(z.void()),
    getOrchestratorModes: oc
      .route({ method: 'GET', path: '/bots/{botId}/orchestrator', summary: "The bot's orchestrator modes" })
      .input(z.object({ botId: z.string() }))
      .output(botOrchestratorModes),
    updateOrchestratorModes: oc
      .route({
        method: 'PATCH',
        path: '/bots/{botId}/orchestrator',
        summary: "Override orchestrator modes for the bot only; null makes a surface follow the global mode again",
      })
      .input(z.object({ botId: z.string(), overrides: z.partialRecord(surface, orchestratorMode.nullable()) }))
      .output(botOrchestratorModes),
    audit: oc
      .route({ method: 'GET', path: '/bots/{botId}/audit', summary: "The bot's audit log: every side-effecting action, reviewed or not, and its computer-use sessions' navigations and summaries, oldest first" })
      .input(z.object({ botId: z.string() }))
      .output(z.array(auditEntry)),
    memory: oc
      .route({ method: 'GET', path: '/bots/{botId}/memory', summary: "The bot's bot memory, every fact, oldest first, including those its prompt leaves out" })
      .input(z.object({ botId: z.string() }))
      .output(z.array(fact)),
    addFact: oc
      .route({ method: 'POST', path: '/bots/{botId}/memory', summary: "Add a fact to the bot's bot memory, from the owner; the bot sees it on its next run" })
      .input(newFact.extend({ botId: z.string() }))
      .output(fact),
    editFact: oc
      .route({
        method: 'PATCH',
        path: '/bots/{botId}/memory/{factId}',
        summary: "Change a fact of the bot's bot memory or of shared memory in place; every bot that sees it sees the change on its next run",
      })
      .input(factChanges.extend({ botId: z.string(), factId: z.coerce.number().int() }))
      .output(fact),
    deleteFact: oc
      .route({
        method: 'DELETE',
        path: '/bots/{botId}/memory/{factId}',
        summary: "Delete a fact of the bot's bot memory or of shared memory for good; it is gone from prompts on their next run",
      })
      .input(z.object({ botId: z.string(), factId: z.coerce.number().int() }))
      .output(z.void()),
  },
  routines: {
    list: oc
      .route({ method: 'GET', path: '/bots/{botId}/routines', summary: "The bot's routines, oldest first, paused ones and fired reminders included" })
      .input(z.object({ botId: z.string() }))
      .output(z.array(routine)),
    create: oc
      .route({ method: 'POST', path: '/bots/{botId}/routines', summary: 'Create a routine for the bot, the owner\'s; at most 20 per bot' })
      .input(newRoutine.extend({ botId: z.string() }))
      .output(routine),
    update: oc
      .route({ method: 'PATCH', path: '/bots/{botId}/routines/{routineId}', summary: "Change a routine's name, instruction or schedule; it becomes the owner's" })
      .input(routineChanges.extend({ botId: z.string(), routineId: z.string() }))
      .output(routine),
    pause: oc
      .route({ method: 'POST', path: '/bots/{botId}/routines/{routineId}/pause', summary: "Pause a routine: it doesn't fire until resumed" })
      .input(z.object({ botId: z.string(), routineId: z.string() }))
      .output(routine),
    resume: oc
      .route({ method: 'POST', path: '/bots/{botId}/routines/{routineId}/resume', summary: 'Resume a routine, its next run computed from now' })
      .input(z.object({ botId: z.string(), routineId: z.string() }))
      .output(routine),
    delete: oc
      .route({ method: 'DELETE', path: '/bots/{botId}/routines/{routineId}', summary: 'Delete a routine and its history for good' })
      .input(z.object({ botId: z.string(), routineId: z.string() }))
      .output(z.void()),
    testRun: oc
      .route({ method: 'POST', path: '/bots/{botId}/routines/{routineId}/test-run', summary: 'Fire a routine now, without moving its next run; skipped while its previous run is going' })
      .input(z.object({ botId: z.string(), routineId: z.string() }))
      .output(routineRun),
    runs: oc
      .route({ method: 'GET', path: '/bots/{botId}/routines/{routineId}/runs', summary: "A routine's run history, newest first" })
      .input(z.object({ botId: z.string(), routineId: z.string() }))
      .output(z.array(routineRun)),
  },
  chats: {
    list: oc
      .route({ method: 'GET', path: '/chats', summary: 'Every chat as the sidebar shows it: pinned, unread, waiting' })
      .output(z.array(chat)),
    read: oc
      .route({
        method: 'POST',
        path: '/chats/{chatId}/read',
        summary: "Mark a chat read up to `upTo`, or its newest message; read state never moves back",
      })
      .input(z.object({ chatId: z.string(), upTo: z.string().optional() }))
      .output(chat),
    setPinned: oc
      .route({
        method: 'PUT',
        path: '/chats/pinned',
        summary: 'Pin exactly these chats, in this order, unpinning every other; returns every chat',
      })
      .input(z.object({ chatIds: z.array(z.string()).max(200) }))
      .output(z.array(chat)),
    messages: oc
      .route({ method: 'GET', path: '/chats/{chatId}/messages', summary: "A chat's messages, oldest first" })
      .input(z.object({ chatId: z.string() }))
      .output(z.array(message)),
    send: oc
      .route({
        method: 'POST',
        path: '/chats/{chatId}/messages',
        summary:
          "Post the owner's message and wake the bot. Files, sent as a multipart form, are saved to the bot's uploads " +
          'folder; the bot is told where, and sees images. In a group chat, the members answer in rounds; files are refused there',
      })
      .input(
        z
          .object({
            chatId: z.string(),
            text: z.string().trim().max(100_000).default(''),
            files: z.array(z.file().max(maxAttachmentBytes)).max(maxAttachments).default([]),
          })
          .refine((input) => input.text || input.files.length, { message: 'Write a message or attach a file' }),
      )
      .output(message),
    attachment: oc
      .route({
        method: 'GET',
        path: '/messages/{messageId}/attachments/{attachmentId}',
        summary: "Download a message's file, as it was when posted",
        outputStructure: 'detailed',
      })
      .input(z.object({ messageId: z.string(), attachmentId: z.string() }))
      .output(z.object({ headers: z.record(z.string(), z.string()), body: z.file() })),
    answer: oc
      .route({
        method: 'POST',
        path: '/messages/{messageId}/answer',
        summary: "Answer a bot's question card, once, and wake the bot with the answer",
      })
      .input(z.object({ messageId: z.string(), answer: questionAnswer }))
      .output(message),
    dismiss: oc
      .route({
        method: 'POST',
        path: '/messages/{messageId}/dismiss',
        summary: "Dismiss a bot's open question card unanswered, without waking the bot; it can't be answered afterwards",
      })
      .input(z.object({ messageId: z.string() }))
      .output(message),
    handBack: oc
      .route({
        method: 'POST',
        path: '/messages/{messageId}/hand-back',
        summary:
          "Hand a bot's screen back after its take-over card, once: `done` when the owner did the step, `skipped` when they " +
          "didn't. Wakes the bot with the outcome",
      })
      .input(z.object({ messageId: z.string(), outcome: handBackOutcome }))
      .output(message),
  },
  groups: {
    create: oc
      .route({
        method: 'POST',
        path: '/groups',
        summary:
          "Create a group chat of these bots with the owner's first message, which the members then answer in rounds. " +
          'It is named after its members until renamed',
      })
      .input(z.object({ memberIds: groupMembers, text: z.string().trim().min(1, 'Write a message').max(100_000) }))
      .output(z.object({ chat, message })),
    update: oc
      .route({
        method: 'PATCH',
        path: '/groups/{chatId}',
        summary: "Rename a group chat (null or blank names it after its members) or set its members, in turn order",
      })
      .input(z.object({ chatId: z.string(), title: groupTitle.optional(), memberIds: groupMembers.optional() }))
      .output(chat),
    delete: oc
      .route({
        method: 'DELETE',
        path: '/groups/{chatId}',
        summary:
          'Delete a group chat for good: ends its rounds, then deletes its messages and files. Its members stay, and what they ' +
          'said stays in their histories',
      })
      .input(z.object({ chatId: z.string() }))
      .output(z.void()),
  },
  providers: {
    list: oc
      .route({ method: 'GET', path: '/providers', summary: 'Every provider OpenBot can use, and whether it is connected' })
      .output(z.array(provider)),
    connect: oc
      .route({
        method: 'POST',
        path: '/providers/{providerId}/connect',
        summary: 'Run a sign-in, streaming its steps; closing the stream cancels it',
      })
      .input(z.object({ providerId: z.string(), method: signInMethod }))
      .output(eventIterator(signInStep)),
    answer: oc
      .route({ method: 'POST', path: '/sign-ins/{signInId}/answer', summary: 'Answer a prompt of a running sign-in' })
      .input(z.object({ signInId: z.string(), promptId: z.string(), value: z.string() }))
      .output(z.void()),
    disconnect: oc
      .route({ method: 'DELETE', path: '/providers/{providerId}/connection', summary: 'Forget the stored credential' })
      .input(z.object({ providerId: z.string() }))
      .output(z.void()),
  },
  models: {
    list: oc
      .route({ method: 'GET', path: '/models', summary: 'Models of connected providers' })
      .output(z.array(model)),
    getSettings: oc
      .route({ method: 'GET', path: '/settings/models', summary: 'The default, computer-use and memory models' })
      .output(modelSettings),
    updateSettings: oc
      .route({
        method: 'PATCH',
        path: '/settings/models',
        summary: 'Set the default, computer-use and memory models; the computer-use model must accept images',
      })
      .input(modelSettings.partial())
      .output(modelSettings),
  },
  general: {
    getSettings: oc
      .route({ method: 'GET', path: '/settings/general', summary: "The owner's time zone" })
      .output(generalSettings),
    updateSettings: oc
      .route({ method: 'PATCH', path: '/settings/general', summary: "Set the owner's time zone; it must be an IANA time zone" })
      .input(z.object({ timeZone }))
      .output(generalSettings),
    detectTimeZone: oc
      .route({
        method: 'POST',
        path: '/settings/general/detected-time-zone',
        summary: "The browser's time zone, kept as the owner's only if none is set yet",
      })
      .input(z.object({ timeZone }))
      .output(generalSettings),
  },
  sharedMemory: {
    list: oc
      .route({ method: 'GET', path: '/settings/shared-memory', summary: 'Shared memory, every fact, oldest first, including those prompts leave out' })
      .output(z.array(fact)),
    add: oc
      .route({ method: 'POST', path: '/settings/shared-memory', summary: 'Add a fact to shared memory, from the owner; every bot sees it on its next run' })
      .input(newFact)
      .output(fact),
    edit: oc
      .route({ method: 'PATCH', path: '/settings/shared-memory/{factId}', summary: 'Change a shared fact in place; every bot sees the change on its next run' })
      .input(factChanges.extend({ factId: z.coerce.number().int() }))
      .output(fact),
    delete: oc
      .route({ method: 'DELETE', path: '/settings/shared-memory/{factId}', summary: "Delete a shared fact for good; it is gone from every bot's prompt on its next run" })
      .input(z.object({ factId: z.coerce.number().int() }))
      .output(z.void()),
  },
  screens: {
    status: oc
      .route({ method: 'GET', path: '/bots/{botId}/screen', summary: "The bot's screen, as the computer keeps it; only read, never started" })
      .input(z.object({ botId: z.string() }))
      .output(screen),
    ticket: oc
      .route({
        method: 'POST',
        path: '/bots/{botId}/screen/tickets',
        summary:
          "A ticket to stream the bot's running screen: open its url as a WebSocket within 30 seconds, once. The stream " +
          'speaks the VNC protocol (RFB) and is the only way to reach the screen from outside the computer',
      })
      .input(z.object({ botId: z.string() }))
      .output(screenTicket),
  },
  orchestrator: {
    getModes: oc
      .route({ method: 'GET', path: '/settings/orchestrator', summary: 'The global orchestrator mode of every surface' })
      .output(orchestratorModes),
    updateModes: oc
      .route({ method: 'PATCH', path: '/settings/orchestrator', summary: 'Set global orchestrator modes; bots may override them' })
      .input(z.partialRecord(surface, orchestratorMode))
      .output(orchestratorModes),
  },
}

export type Contract = typeof contract
export type ApiClient = ContractRouterClient<Contract>

/** A typed client for the HTTP API at `url` (e.g. `https://host/api`), for the web app and later mobile. */
export function createApiClient(url: string): ApiClient {
  return createORPCClient(new OpenAPILink(contract, { url }))
}
