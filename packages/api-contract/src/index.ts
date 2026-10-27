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
})
export type QuestionCardInfo = z.infer<typeof questionCard>

/** An interactive item in a chat that asks the owner for something. */
export const card = z.discriminatedUnion('type', [questionCard])
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
  /** Place among pinned chats, 0 first; null when not pinned. Pinned chats sit above the rest. */
  pinnedPosition: z.number().int().nonnegative().nullable(),
  /** A bot posted since the owner last opened the chat. */
  unread: z.boolean(),
  /** The prompt of the newest question card still open: the chat needs the owner. Null when nothing waits. */
  waitingFor: z.string().nullable(),
  /** The newest message, for the sidebar's preview line; null when the chat is empty. */
  lastMessage: message.pick({ author: true, authorName: true, text: true, attachments: true, createdAt: true }).nullable(),
})
export type ChatInfo = z.infer<typeof chat>

export const onboarding = z.object({
  provider: z.boolean(),
  defaultModel: z.boolean(),
  bot: z.boolean(),
  /** Every step is done; until then the web app shows onboarding. */
  done: z.boolean(),
})
export type Onboarding = z.infer<typeof onboarding>

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
  z.object({ type: z.literal('bot.status'), botId: z.string(), working: z.boolean(), error: z.string().nullable() }),
  z.object({ type: z.literal('message.created'), message }),
  /** A chat's sidebar state changed: a message, a read, a pin; `chat` is all of it as it is now. */
  z.object({ type: z.literal('chat.updated'), chat }),
  /** A message changed, e.g. the owner answered its card; `message` is all of it as it is now. */
  z.object({ type: z.literal('message.updated'), message }),
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

/** Model refs; null means "same as default" (for the default model itself: not chosen yet). */
export const modelSettings = z.object({
  defaultModel: z.string().nullable(),
  computerUseModel: z.string().nullable(),
})
export type ModelSettings = z.infer<typeof modelSettings>

/** Kinds of side effect the orchestrator reviews. Messages between bots are not one. */
export const surfaces = [
  'shell',
  'computer_session',
  'mcp',
  'vault',
  'plugin_request',
  'routine_change',
  'memory_global_write',
] as const
const surface = z.enum(surfaces)
/** off: not reviewed; shadow: reviewed and logged, never blocked; enforce: a deny blocks the action. */
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

/** One orchestrator review of a bot's tool call. */
export const auditEntry = z.object({
  id: z.string(),
  botId: z.string(),
  surface,
  tool: z.string(),
  /** The tool call's input, with secrets redacted. */
  input: z.unknown(),
  verdict,
  /** The surface's mode for the bot when reviewed. */
  mode: orchestratorMode,
  /** Milliseconds since the epoch. */
  createdAt: z.number(),
})
export type AuditEntryInfo = z.infer<typeof auditEntry>

export const contract = {
  health: oc
    .route({ method: 'GET', path: '/health', summary: 'Liveness, used by the installer and the updater' })
    .output(z.object({ status: z.literal('ok'), epoch: z.string() })),
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
    stop: oc
      .route({ method: 'POST', path: '/bots/{botId}/stop', summary: "Abort the bot's current run; returns once it is idle" })
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
      .route({ method: 'GET', path: '/bots/{botId}/audit', summary: "The bot's audit log: every orchestrator review, oldest first" })
      .input(z.object({ botId: z.string() }))
      .output(z.array(auditEntry)),
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
          'folder; the bot is told where, and sees images',
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
      .route({ method: 'GET', path: '/settings/models', summary: 'The default and computer-use models' })
      .output(modelSettings),
    updateSettings: oc
      .route({
        method: 'PATCH',
        path: '/settings/models',
        summary: 'Set the default and computer-use models; the computer-use model must accept images',
      })
      .input(modelSettings.partial())
      .output(modelSettings),
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
