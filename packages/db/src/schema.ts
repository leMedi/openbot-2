import { sql } from 'drizzle-orm'
import { type AnySQLiteColumn, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { uuidv7 } from 'uuidv7'

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => uuidv7())

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)

const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
    .$onUpdateFn(() => new Date())

/** Everything configured after the database opens: default model, computer-use model, orchestrator modes… */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: updatedAt(),
})

/** Credentials OpenBot holds to reach providers; encrypted, never returned by any API or tool (ADR 0006). */
export const systemCredentials = sqliteTable('system_credentials', {
  /** e.g. `provider:anthropic`. */
  key: text('key').primaryKey(),
  /** Encrypted with OPENBOT_SECRET_KEY. */
  ciphertext: text('ciphertext').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

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
export type Surface = (typeof surfaces)[number]

export const orchestratorModes = ['off', 'shadow', 'enforce'] as const
export type OrchestratorMode = (typeof orchestratorModes)[number]

export type Verdict =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string; proposedRule?: string }

export const avatarShapes = ['blob', 'pebble', 'squircle', 'tablet', 'wedge', 'hex', 'cloud', 'teardrop'] as const
export type AvatarShape = (typeof avatarShapes)[number]

export const bots = sqliteTable(
  'bots',
  {
    id: id(),
    /** Unique, ignoring case: the owner and other bots mention a bot by name. */
    name: text('name').notNull(),
    title: text('title'),
    /** The owner's instructions: who the bot is and how it behaves. */
    instructions: text('instructions').notNull().default(''),
    avatarShape: text('avatar_shape', { enum: avatarShapes }).notNull(),
    /** One of the persona-mark colours (black, brown, red…). */
    avatarColor: text('avatar_color').notNull(),
    /** `provider/modelId`; null follows the default model in settings. */
    model: text('model'),
    /** The bot's one history (ADR 0001); set when its first run starts. */
    historyId: text('history_id').unique(),
    /** X display of the bot's screen; stable for the bot's lifetime. */
    displayNumber: integer('display_number').unique(),
    /** Orchestrator modes overriding the global ones in settings, for this bot only. */
    orchestratorModes: text('orchestrator_modes', { mode: 'json' })
      .$type<Partial<Record<Surface, OrchestratorMode>>>()
      .notNull()
      .default(sql`'{}'`),
    /**
     * Since when the bot owes the owner a reply (Grok's ack obligation): set with the owner's DM message, answer or
     * hand-back, cleared by the bot's next message or card in its DM; null when it owes none. A bot still owing one
     * when the server starts is woken to reply.
     */
    replyOwedAt: integer('reply_owed_at', { mode: 'timestamp_ms' }),
    /** How many times a start woke the bot for the reply it owes; it gives up after 3. */
    replyRedrives: integer('reply_redrives').notNull().default(0),
    /**
     * The memory block of the bot's instructions as rendered for its compaction epoch (the id of the entry its context
     * starts from; null before its first compaction), kept until the epoch changes so its prompt stays cached.
     */
    memoryBlock: text('memory_block', { mode: 'json' }).$type<{ epoch: string | null; text: string }>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('bots_name_unique').on(sql`lower(${table.name})`)],
)

export const chatKinds = ['dm', 'group'] as const
export type ChatKind = (typeof chatKinds)[number]

export const chats = sqliteTable(
  'chats',
  {
    id: id(),
    kind: text('kind', { enum: chatKinds }).notNull(),
    /** The DM's bot; deleting the bot deletes its DM. Null for group chats. */
    botId: text('bot_id')
      .unique()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** Group chats only; null names the group from its members. */
    title: text('title'),
    /** Group chats only: member bot ids. Deleting a bot removes it here in code. */
    members: text('members', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * Group chats only: for each member (bot id), the newest message its latest turn showed it, so its next turn shows
     * only what came after. A member that has had no turn has no entry.
     */
    turnCursors: text('turn_cursors', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    /** Sidebar order of pinned chats; null when not pinned. */
    pinnedPosition: integer('pinned_position'),
    /** The newest message the owner has seen; a bot's message after it, other than one between bots, makes the chat unread. Null: none seen yet. */
    lastReadMessageId: text('last_read_message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('chats_kind_idx').on(table.kind)],
)

/** A file posted with a message. The server keeps a copy, as it was when posted, for the owner to download. */
export type Attachment = {
  /** Names the server's copy. */
  id: string
  name: string
  mimeType: string
  size: number
  /** Path on the computer, under the bot's folder. */
  path: string
}

export const messageAuthors = ['owner', 'bot'] as const
export type MessageAuthor = (typeof messageAuthors)[number]

/** A message between bots, as it appears in a bot's DM: `to` the peer (outgoing) or `from` the peer (incoming). */
export const botMessageDirections = ['to', 'from'] as const
export type BotMessageDirection = (typeof botMessageDirections)[number]

export const messages = sqliteTable(
  'messages',
  {
    id: id(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    author: text('author', { enum: messageAuthors }).notNull(),
    /** Set when `author` is `bot`; nulled when that bot is deleted. */
    authorBotId: text('author_bot_id').references((): AnySQLiteColumn => bots.id, { onDelete: 'set null' }),
    /** Author's name when posted, shown as "Name (deleted)" once the bot is gone. */
    authorName: text('author_name').notNull(),
    text: text('text').notNull().default(''),
    attachments: text('attachments', { mode: 'json' })
      .$type<Attachment[]>()
      .notNull()
      .default(sql`'[]'`),
    /** Card payload (question, take-over…); its shape is owned by `core`. */
    card: text('card', { mode: 'json' }).$type<unknown>(),
    /** Card answer or progress. */
    cardState: text('card_state', { mode: 'json' }).$type<unknown>(),
    /** Messages between bots only. */
    direction: text('direction', { enum: botMessageDirections }),
    peerBotId: text('peer_bot_id').references((): AnySQLiteColumn => bots.id, { onDelete: 'set null' }),
    peerName: text('peer_name'),
    /** ID of the tool call that posted this message; makes replayed calls idempotent. */
    idempotencyKey: text('idempotency_key').unique(),
    createdAt: createdAt(),
  },
  (table) => [index('messages_chat_idx').on(table.chatId, table.id)],
)

/**
 * What an audit entry records: a side-effecting tool call (`action`), a page a computer-use session's browser opened
 * (`navigation`), what a computer-use session did once it ended (`session_summary`), or a change memory extraction made
 * or was refused, or an extraction skipped after failing (`extraction`, under `memory_shared_write`).
 */
export const auditKinds = ['action', 'navigation', 'session_summary', 'extraction'] as const
export type AuditKind = (typeof auditKinds)[number]

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: auditKinds }).notNull().default('action'),
    surface: text('surface', { enum: surfaces }).notNull(),
    /** The tool the bot called; for a navigation, the session's tool that opened the page. */
    tool: text('tool').notNull(),
    /** The tool call's input, a navigation's URL and title, or a session's summary; with secrets redacted. */
    action: text('action', { mode: 'json' }).$type<unknown>().notNull(),
    /** Null when nothing was reviewed: the surface was off, or the entry isn't an action. */
    verdict: text('verdict', { mode: 'json' }).$type<Verdict>(),
    /** The surface's mode for the bot at the time. */
    mode: text('mode', { enum: orchestratorModes }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('audit_log_bot_idx').on(table.botId, table.id)],
)

/**
 * What woke each bot (`AgentRuntime.wake`), kept so a restart loses none of its queue. A row stays once it leaves the
 * queue, so an input of the same id never runs twice. A group chat's turns aren't kept: its rounds end with the
 * server. Its shape is owned by `core`.
 */
export const botInputs = sqliteTable(
  'bot_inputs',
  {
    id: id(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The input's own id, e.g. that of the message that woke the bot. */
    inputId: text('input_id').notNull(),
    /** The input: its lane, priority, text, files and attempt. */
    input: text('input', { mode: 'json' }).$type<unknown>().notNull(),
    /**
     * When it was queued, as one counter across all bots: a bot's inputs in this order, sorted by lane, are its queue.
     * Renewed when an interrupt queues it again.
     */
    position: integer('position').notNull(),
    /** When it left the queue: its run was submitted to pi-durable, which keeps it from there, or couldn't start. */
    takenAt: integer('taken_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('bot_inputs_input_unique').on(table.botId, table.inputId), uniqueIndex('bot_inputs_position_unique').on(table.position)],
)

/** Whose a fact is: one bot's (bot memory) or every bot's (shared memory). */
export const memoryScopes = ['bot', 'shared'] as const
export type MemoryScope = (typeof memoryScopes)[number]

/** How long a fact stays relevant: always (`profile`), fading but kept (`log`), or a week (`note`). */
export const factTiers = ['profile', 'log', 'note'] as const
export type FactTier = (typeof factTiers)[number]

/** Who a fact was learned from: the owner, or a bot. */
export const factSources = ['owner', 'bot'] as const
export type FactSource = (typeof factSources)[number]

/**
 * Bots' memory (design §5.3, ADR 0010): one remembered fact per row. Bots reach it only through `update_state`, and see
 * it only as the memory block in their prompt. Every delete is a hard delete; edits replace in place, keeping the id.
 */
export const memories = sqliteTable(
  'memories',
  {
    /** Stable across edits; what bots and the owner name a fact by. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope', { enum: memoryScopes }).notNull(),
    /** The bot whose bot memory it is; deleting the bot deletes it. Null for shared memory. */
    botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    tier: text('tier', { enum: factTiers }).notNull(),
    /** At most 500 characters. */
    content: text('content').notNull(),
    /** 1 to 5. */
    importance: integer('importance').notNull().default(3),
    source: text('source', { enum: factSources }).notNull(),
    /** Set when `source` is `bot`; nulled when that bot is deleted. */
    sourceBotId: text('source_bot_id').references((): AnySQLiteColumn => bots.id, { onDelete: 'set null' }),
    /** The source bot's name when it wrote the fact. */
    sourceBotName: text('source_bot_name'),
    /** Written from the server's clock. */
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('memories_bot_idx').on(table.botId)],
)

export type Setting = typeof settings.$inferSelect
export type SystemCredential = typeof systemCredentials.$inferSelect
export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert
export type Chat = typeof chats.$inferSelect
export type NewChat = typeof chats.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type AuditEntry = typeof auditLog.$inferSelect
export type NewAuditEntry = typeof auditLog.$inferInsert
export type Fact = typeof memories.$inferSelect
