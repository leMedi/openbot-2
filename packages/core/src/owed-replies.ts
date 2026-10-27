import { bots, chats, type Db, type Message, messages } from '@openbot/db'
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm'

/** A start wakes a bot for the reply it owes at most this many times (Grok's `MAX_ACK_REDRIVES`). */
export const maxReplyRedrives = 3

/** The bot whose DM `chatId` is; none for a group chat. */
const botOfDm = (chatId: string) => sql`(select ${chats.botId} from ${chats} where ${chats.id} = ${chatId})`

/**
 * The bot of DM `chatId` owes the owner a reply, from now unless it owed one already; nothing for a group chat. Run in
 * the transaction of the owner's message, answer or hand-back, so none is ever posted without it.
 */
export async function oweReply(tx: Pick<Db, 'update'>, chatId: string): Promise<void> {
  await tx
    .update(bots)
    .set({ replyOwedAt: sql`coalesce(${bots.replyOwedAt}, ${Date.now()})` })
    .where(eq(bots.id, botOfDm(chatId)))
}

/** The bot of DM `chatId` posted there, a message or a card: it owes the owner no reply. */
export async function replied(tx: Pick<Db, 'update'>, chatId: string): Promise<void> {
  await tx
    .update(bots)
    .set({ replyOwedAt: null, replyRedrives: 0 })
    .where(and(eq(bots.id, botOfDm(chatId)), isNotNull(bots.replyOwedAt)))
}

/** The bots that owe the owner a reply. */
export async function botsOwingReplies(db: Db): Promise<string[]> {
  const rows = await db.select({ id: bots.id }).from(bots).where(isNotNull(bots.replyOwedAt))
  return rows.map((row) => row.id)
}

/**
 * Counts a start waking the bot for the reply it owes. False when it owes none any more, or was woken
 * `maxReplyRedrives` times already: it then gives up, and owes none.
 */
export async function redriveReply(db: Db, botId: string): Promise<boolean> {
  const [counted] = await db
    .update(bots)
    .set({ replyRedrives: sql`${bots.replyRedrives} + 1` })
    .where(and(eq(bots.id, botId), isNotNull(bots.replyOwedAt), lt(bots.replyRedrives, maxReplyRedrives)))
    .returning({ id: bots.id })
  if (counted) return true
  await db.update(bots).set({ replyOwedAt: null, replyRedrives: 0 }).where(and(eq(bots.id, botId), isNotNull(bots.replyOwedAt)))
  return false
}

/** The owner's messages in DM `chatId` since the bot's latest message or card there, oldest first. */
export async function sinceLastReply(db: Db, chatId: string): Promise<Message[]> {
  const [last] = await db
    .select({ id: messages.id })
    .from(messages)
    // A bot's message to another, shown in its DM, isn't one to the owner.
    .where(and(eq(messages.chatId, chatId), eq(messages.author, 'bot'), isNull(messages.direction)))
    .orderBy(desc(messages.id))
    .limit(1)
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.author, 'owner'), last ? gt(messages.id, last.id) : undefined))
    .orderBy(asc(messages.id))
}
