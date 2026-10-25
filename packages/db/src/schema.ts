import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
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

export const bots = sqliteTable('bots', {
  id: id(),
  /** Unique @mention handle. */
  handle: text('handle').notNull().unique(),
  name: text('name').notNull(),
  title: text('title'),
  /** Appended to the bot's system prompt. */
  instructions: text('instructions').notNull(),
  avatarType: text('avatar_type', { enum: ['bot'] })
    .notNull()
    .default('bot'),
  botColor: text('bot_color').notNull(),
  botFgColor: text('bot_fg_color').notNull(),
  /** `provider/modelId`; null uses OPENBOT_DEFAULT_MODEL. */
  model: text('model'),
  /** Soft delete: conversations reference bots from a JSON column, without foreign keys. */
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export type Participant = {
  botId: string
  /** The bot's own pi-durable conversation for this group; set on its first run. */
  piConversationId?: string
}

export const conversations = sqliteTable('conversations', {
  id: id(),
  title: text('title'),
  /** Bots in turn order. A 1:1 chat is a conversation with one participant. */
  participants: text('participants', { mode: 'json' })
    .$type<Participant[]>()
    .notNull()
    .default(sql`'[]'`),
  /** Runs each bot may take after a human message, mention runs included. */
  maxRunsPerBot: integer('max_runs_per_bot').notNull().default(1),
  /** Cap on all bot runs after a human message. */
  maxTurnsPerMessage: integer('max_turns_per_message').notNull().default(10),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const conversationMessages = sqliteTable(
  'conversation_messages',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'bot'] }).notNull(),
    /** Set when `role` is `bot`. */
    authorBotId: text('author_bot_id').references(() => bots.id),
    content: text('content').notNull(),
    /** User messages: `pending` until submitted to every bot that must see them. */
    deliveryStatus: text('delivery_status', { enum: ['pending', 'delivered'] }),
    /** pi task ID of the sendMessage call that wrote this message; makes replayed calls idempotent. */
    sourceTaskId: text('source_task_id').unique(),
    createdAt: createdAt(),
  },
  (table) => [index('conversation_messages_conversation_idx').on(table.conversationId, table.id)],
)

export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert
export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
export type ConversationMessage = typeof conversationMessages.$inferSelect
export type NewConversationMessage = typeof conversationMessages.$inferInsert
