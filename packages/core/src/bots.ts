import { type Bot, type Db, type NewBot, bots, chats } from '@openbot/db'
import { and, asc, eq, ne, sql } from 'drizzle-orm'

export class NameTakenError extends Error {}

/** What the owner sets on a bot. */
export type BotProfile = Pick<NewBot, 'name' | 'title' | 'instructions' | 'avatarShape' | 'avatarColor' | 'model'>

/** Throws `NameTakenError` when a bot other than `exceptId` has `name`, ignoring case. */
async function assertNameFree(tx: Pick<Db, 'select'>, name: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: bots.id })
    .from(bots)
    .where(and(sql`lower(${bots.name}) = lower(${name})`, exceptId ? ne(bots.id, exceptId) : undefined))
  if (taken) throw new NameTakenError(`There is already a bot named ${name}`)
}

/** A bot with the id of its DM. */
export type BotWithChat = Bot & { chatId: string }

/** The display after the highest one taken; screens start at display 1. */
async function nextDisplay(tx: Pick<Db, 'select'>): Promise<number> {
  const [row] = await tx.select({ highest: sql<number | null>`max(${bots.displayNumber})` }).from(bots)
  return (row?.highest ?? 0) + 1
}

/**
 * Creates a bot and its DM in one transaction, giving it the display its screen runs on. Throws `NameTakenError` when
 * another bot has the name, ignoring case.
 */
export async function createBot(db: Db, values: BotProfile): Promise<BotWithChat> {
  return db.transaction(async (tx) => {
    await assertNameFree(tx, values.name)
    const [bot] = await tx
      .insert(bots)
      .values({ ...values, displayNumber: await nextDisplay(tx) })
      .returning()
    const [chat] = await tx.insert(chats).values({ kind: 'dm', botId: bot!.id }).returning()
    return { ...bot!, chatId: chat!.id }
  })
}

/**
 * Changes a bot's profile. Throws `NameTakenError` when another bot has the new name, ignoring case; returns undefined
 * when there is no such bot.
 */
export async function updateBot(
  db: Db,
  id: string,
  changes: Partial<BotProfile>,
): Promise<BotWithChat | undefined> {
  await db.transaction(async (tx) => {
    if (changes.name !== undefined) await assertNameFree(tx, changes.name, id)
    if (Object.keys(changes).length > 0) await tx.update(bots).set(changes).where(eq(bots.id, id))
  })
  return getBot(db, id)
}

/**
 * Deletes a bot for good (ADR 0009): its row, and through cascades its DM with its messages and its audit entries. It
 * leaves group chats; messages it posted elsewhere keep a copy of its name. Returns the deleted bot with the group
 * chats it left, or undefined when there is no such bot.
 */
export async function deleteBot(db: Db, id: string): Promise<(BotWithChat & { leftGroups: string[] }) | undefined> {
  const bot = await getBot(db, id)
  if (!bot) return undefined
  const leftGroups = await db.transaction(async (tx) => {
    const groups = await tx
      .select({ id: chats.id, members: chats.members })
      .from(chats)
      .where(and(eq(chats.kind, 'group'), sql`exists (select 1 from json_each(${chats.members}) where value = ${id})`))
    for (const group of groups) {
      await tx
        .update(chats)
        .set({ members: group.members.filter((member) => member !== id) })
        .where(eq(chats.id, group.id))
    }
    await tx.delete(bots).where(eq(bots.id, id))
    return groups.map((group) => group.id)
  })
  return { ...bot, leftGroups }
}

/** The bot with its screen's display, given one if it has none (bots made before screens). */
export async function withDisplay(db: Db, bot: BotWithChat): Promise<BotWithChat & { displayNumber: number }> {
  if (bot.displayNumber !== null) return { ...bot, displayNumber: bot.displayNumber }
  const displayNumber = await db.transaction(async (tx) => {
    const [row] = await tx.select({ displayNumber: bots.displayNumber }).from(bots).where(eq(bots.id, bot.id))
    if (row?.displayNumber != null) return row.displayNumber
    const next = await nextDisplay(tx)
    await tx.update(bots).set({ displayNumber: next }).where(eq(bots.id, bot.id))
    return next
  })
  return { ...bot, displayNumber }
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

/** The bot named `name`, ignoring case and a leading `@`, as bots are mentioned. */
export async function findBotByName(db: Db, name: string): Promise<BotWithChat | undefined> {
  const [row] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(sql`lower(${bots.name}) = lower(${name.trim().replace(/^@/, '')})`)
  return row && getBot(db, row.id)
}

/** The bot whose one history is `historyId` (ADR 0001). */
export async function findBotByHistory(db: Db, historyId: string): Promise<BotWithChat | undefined> {
  const [row] = await db.select({ id: bots.id }).from(bots).where(eq(bots.historyId, historyId))
  return row && getBot(db, row.id)
}

export async function setBotHistory(db: Db, botId: string, historyId: string): Promise<void> {
  await db.update(bots).set({ historyId }).where(eq(bots.id, botId))
}
