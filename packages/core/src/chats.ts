import { type Chat, type Db, type Message, type NewMessage, chats, messages } from '@openbot/db'
import { asc, eq, inArray, sql } from 'drizzle-orm'

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

/** There is no chat with that id. */
export class ChatNotFoundError extends Error {}

/** A chat as the sidebar shows it: whether a bot posted since the owner looked, what waits for them, the newest message. */
export type ChatSummary = Chat & {
  unread: boolean
  /** The prompt of the newest open question card, or null. */
  waitingFor: string | null
  lastMessage: Message | null
}

const newestMessageId = sql<string | null>`(select max(${messages.id}) from ${messages} where ${messages.chatId} = ${chats.id})`

/** Chats with their sidebar state, oldest first, or only `chatIds`. */
export async function listChatSummaries(db: Db, chatIds?: readonly string[]): Promise<ChatSummary[]> {
  const rows = await db
    .select({
      chat: chats,
      unread: sql<number>`exists (
        select 1 from ${messages}
        where ${messages.chatId} = ${chats.id} and ${messages.author} = 'bot'
          and (${chats.lastReadMessageId} is null or ${messages.id} > ${chats.lastReadMessageId})
      )`,
      waitingFor: sql<string | null>`(
        select json_extract(${messages.card}, '$.prompt') from ${messages}
        where ${messages.chatId} = ${chats.id} and json_extract(${messages.card}, '$.type') = 'question'
          and ${messages.cardState} is null
        order by ${messages.id} desc limit 1
      )`,
      lastMessage: messages,
    })
    .from(chats)
    .leftJoin(messages, eq(messages.id, newestMessageId))
    .where(chatIds ? inArray(chats.id, [...chatIds]) : undefined)
    .orderBy(asc(chats.id))
  return rows.map(({ chat, unread, waitingFor, lastMessage }) => ({ ...chat, unread: Boolean(unread), waitingFor, lastMessage }))
}

/** One chat with its sidebar state, or undefined when there is no such chat. */
export async function getChatSummary(db: Db, chatId: string): Promise<ChatSummary | undefined> {
  const [summary] = await listChatSummaries(db, [chatId])
  return summary
}

/**
 * Marks a chat read up to message `upTo`, or up to its newest message. Message ids are uuidv7, so comparing them orders
 * messages by time. Read state only moves forward, so a late request
 * from a tab that saw less never makes newer messages unread again. Throws `ChatNotFoundError` for no such chat.
 */
export async function markChatRead(db: Db, chatId: string, upTo?: string): Promise<void> {
  const target = upTo
    ? sql`(select ${messages.id} from ${messages} where ${messages.id} = ${upTo} and ${messages.chatId} = ${chatId})`
    : sql`(select max(${messages.id}) from ${messages} where ${messages.chatId} = ${chatId})`
  const [chat] = await db
    .update(chats)
    .set({
      lastReadMessageId: sql`case
        when ${target} is null then ${chats.lastReadMessageId}
        when ${chats.lastReadMessageId} is null or ${target} > ${chats.lastReadMessageId} then ${target}
        else ${chats.lastReadMessageId} end`,
    })
    .where(eq(chats.id, chatId))
    .returning({ id: chats.id })
  if (!chat) throw new ChatNotFoundError('No such chat')
}

/**
 * Pins exactly `chatIds`, in that order, and unpins every other chat. Returns the ids of chats whose place changed.
 * Throws `ChatNotFoundError` when one of them doesn't exist, changing nothing.
 */
export async function setPinnedChats(db: Db, chatIds: readonly string[]): Promise<string[]> {
  const order = [...new Set(chatIds)]
  return db.transaction(async (tx) => {
    const all = await tx.select({ id: chats.id, pinnedPosition: chats.pinnedPosition }).from(chats)
    const known = new Set(all.map((chat) => chat.id))
    const missing = order.find((id) => !known.has(id))
    if (missing) throw new ChatNotFoundError(`No such chat: ${missing}`)
    const changed: string[] = []
    for (const chat of all) {
      const position = order.indexOf(chat.id)
      const pinnedPosition = position === -1 ? null : position
      if (pinnedPosition === chat.pinnedPosition) continue
      await tx.update(chats).set({ pinnedPosition }).where(eq(chats.id, chat.id))
      changed.push(chat.id)
    }
    return changed
  })
}
