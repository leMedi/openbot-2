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
    /** Sidebar order of pinned chats; null when not pinned. */
    pinnedPosition: integer('pinned_position'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('chats_kind_idx').on(table.kind)],
)

export type Attachment = {
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

export const surfaces = [
  'shell',
  'computer_session',
  'mcp',
  'vault',
  'plugin_request',
  'routine_change',
  'memory_global_write',
] as const
export type Surface = (typeof surfaces)[number]

export const orchestratorModes = ['off', 'shadow', 'enforce'] as const
export type OrchestratorMode = (typeof orchestratorModes)[number]

export type Verdict =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string; proposedRule?: string }

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    surface: text('surface', { enum: surfaces }).notNull(),
    /** The proposed action with secrets redacted. */
    action: text('action', { mode: 'json' }).$type<unknown>().notNull(),
    verdict: text('verdict', { mode: 'json' }).$type<Verdict>().notNull(),
    mode: text('mode', { enum: orchestratorModes }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('audit_log_bot_idx').on(table.botId, table.id)],
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
