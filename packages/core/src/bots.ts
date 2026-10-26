import { type Bot, type Db, type NewBot, bots, chats } from '@openbot/db'
import { asc, eq } from 'drizzle-orm'

export class HandleTakenError extends Error {}

/** A bot with the id of its DM. */
export type BotWithChat = Bot & { chatId: string }

/** Creates a bot and its DM in one transaction. Throws `HandleTakenError` when another bot has the handle. */
export async function createBot(db: Db, values: Omit<NewBot, 'id' | 'historyId' | 'displayNumber'>): Promise<BotWithChat> {
  return db.transaction(async (tx) => {
    const [taken] = await tx.select({ id: bots.id }).from(bots).where(eq(bots.handle, values.handle))
    if (taken) throw new HandleTakenError(`@${values.handle} is already taken`)
    const [bot] = await tx.insert(bots).values(values).returning()
    const [chat] = await tx.insert(chats).values({ kind: 'dm', botId: bot!.id }).returning()
    return { ...bot!, chatId: chat!.id }
  })
}

export async function listBots(db: Db): Promise<BotWithChat[]> {
  const rows = await db
    .select({ bot: bots, chatId: chats.id })
    .from(bots)
    .innerJoin(chats, eq(chats.botId, bots.id))
    .orderBy(asc(bots.id))
  return rows.map(({ bot, chatId }) => ({ ...bot, chatId }))
}

export async function getBot(db: Db, id: string): Promise<BotWithChat | undefined> {
  const [row] = await db.select({ bot: bots, chatId: chats.id }).from(bots).innerJoin(chats, eq(chats.botId, bots.id)).where(eq(bots.id, id))
  return row && { ...row.bot, chatId: row.chatId }
}

/** The bot whose one history is `historyId` (ADR 0001). */
export async function findBotByHistory(db: Db, historyId: string): Promise<BotWithChat | undefined> {
  const [row] = await db.select({ id: bots.id }).from(bots).where(eq(bots.historyId, historyId))
  return row && getBot(db, row.id)
}

export async function setBotHistory(db: Db, botId: string, historyId: string): Promise<void> {
  await db.update(bots).set({ historyId }).where(eq(bots.id, botId))
}
