import { type Chat, type Db, type Message, type NewMessage, chats, messages } from '@openbot/db'
import { asc, eq } from 'drizzle-orm'

export async function getChat(db: Db, id: string): Promise<Chat | undefined> {
  const [chat] = await db.select().from(chats).where(eq(chats.id, id))
  return chat
}

export async function getMessage(db: Db, id: string): Promise<Message | undefined> {
  const [message] = await db.select().from(messages).where(eq(messages.id, id))
  return message
}

/** A chat's messages, oldest first. */
export async function listMessages(db: Db, chatId: string): Promise<Message[]> {
  return db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.id))
}

/**
 * Posts a message. With an `idempotencyKey` (a bot's tool call), posting again returns the first message and
 * `created: false`, so a replayed call never posts twice.
 */
export async function postMessage(db: Db, values: NewMessage): Promise<{ message: Message; created: boolean }> {
  const [inserted] = await db.insert(messages).values(values).onConflictDoNothing({ target: messages.idempotencyKey }).returning()
  if (inserted) return { message: inserted, created: true }
  const [existing] = await db.select().from(messages).where(eq(messages.idempotencyKey, values.idempotencyKey!))
  return { message: existing!, created: false }
}
