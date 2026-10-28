import { bots, type Db, type Fact, type FactTier, factTiers, memories } from '@openbot/db'
import { and, asc, eq } from 'drizzle-orm'

export { factTiers }
export type { Fact, FactTier }

/** A fact's content is at most this many characters. */
export const maxFactLength = 500

/** The least important a fact can be: trivia. */
export const minImportance = 1
/** The most important a fact can be: essential. */
export const maxImportance = 5
/** A fact's importance unless said otherwise. */
export const defaultImportance = 3

/** The profile section of the memory block holds at most this many characters; the least important facts drop out. */
export const maxProfileChars = 2000
/** The "Recently" section of the memory block holds at most this many characters; facts below the cut stay unseen. */
export const maxRecentChars = 4000
/** A note leaves the prompt this long after it was learned. */
export const noteLifetimeMs = 7 * 24 * 60 * 60 * 1000
/** A log or note fact's rank halves every this long (Grok's 30-day half-life). */
export const rankHalfLifeMs = 30 * 24 * 60 * 60 * 1000

/**
 * The answer to any id a bot can't reach: one that never existed, is gone, or is another bot's. They answer the same,
 * so a bot learns nothing of others' memory.
 */
export class NoSuchFactError extends Error {
  constructor(id: number) {
    super(`There is no fact [${id}] in your memory.`)
    this.name = 'NoSuchFactError'
  }
}

/** A fact's content or importance a bot or the owner may not write. */
export class InvalidFactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidFactError'
  }
}

/** What a fact's content is once checked: trimmed, not empty, at most `maxFactLength` characters. */
function checkedContent(text: string): string {
  const content = text.trim()
  if (!content) throw new InvalidFactError('A fact needs some text.')
  if (content.length > maxFactLength) {
    throw new InvalidFactError(`A fact is at most ${maxFactLength} characters; this one has ${content.length}. Shorten it, or split it into facts.`)
  }
  return content
}

function checkedImportance(importance: number): number {
  if (!Number.isInteger(importance) || importance < minImportance || importance > maxImportance) {
    throw new InvalidFactError(`Importance is a whole number from ${minImportance} to ${maxImportance}.`)
  }
  return importance
}

/** Only the bot's own bot memory: the ownership check every way of reaching a fact goes through. */
const ownBotFact = (botId: string, id: number) => and(eq(memories.id, id), eq(memories.scope, 'bot'), eq(memories.botId, botId))

/** The bot's bot memory, oldest first. */
export async function listBotFacts(db: Db, botId: string): Promise<Fact[]> {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.scope, 'bot'), eq(memories.botId, botId)))
    .orderBy(asc(memories.id))
}

/**
 * Saves a fact the bot wrote itself in its bot memory, learned `now`. Throws `InvalidFactError` for an empty or too
 * long text or an importance out of range.
 */
export async function writeBotFact(
  db: Db,
  bot: { id: string; name: string },
  { tier, text, importance = defaultImportance }: { tier: FactTier; text: string; importance?: number },
  now: number,
): Promise<Fact> {
  const [fact] = await db
    .insert(memories)
    .values({
      scope: 'bot',
      botId: bot.id,
      tier,
      content: checkedContent(text),
      importance: checkedImportance(importance),
      source: 'bot',
      sourceBotId: bot.id,
      sourceBotName: bot.name,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .returning()
  return fact!
}

/**
 * Changes a fact of the bot's bot memory in place, keeping its id and when it was learned. Throws `NoSuchFactError`
 * unless it is one, and `InvalidFactError` for nothing to change or a bad text or importance.
 */
export async function editBotFact(
  db: Db,
  botId: string,
  id: number,
  changes: { text?: string; tier?: FactTier; importance?: number },
  now: number,
): Promise<Fact> {
  const values = {
    ...(changes.text !== undefined && { content: checkedContent(changes.text) }),
    ...(changes.tier !== undefined && { tier: changes.tier }),
    ...(changes.importance !== undefined && { importance: checkedImportance(changes.importance) }),
  }
  if (!Object.keys(values).length) throw new InvalidFactError('Give the fact a new text, tier or importance.')
  const [fact] = await db
    .update(memories)
    .set({ ...values, updatedAt: new Date(now) })
    .where(ownBotFact(botId, id))
    .returning()
  if (!fact) throw new NoSuchFactError(id)
  return fact
}

/** Deletes a fact of the bot's bot memory for good. Throws `NoSuchFactError` unless it is one. */
export async function forgetBotFact(db: Db, botId: string, id: number): Promise<void> {
  const deleted = await db.delete(memories).where(ownBotFact(botId, id)).returning({ id: memories.id })
  if (!deleted.length) throw new NoSuchFactError(id)
}

/** `- [12] (learned 2026-10-25) fact`, the date in the owner's time zone. */
function factLine(fact: Fact, timeZone: string): string {
  const learned = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fact.createdAt)
  return `- [${fact.id}] (learned ${learned}) ${fact.content}`
}

/** `lines`, in order, up to the first that would take them past `maxChars` characters. */
function upTo(lines: string[], maxChars: number): string[] {
  const kept: string[] = []
  let length = -1
  for (const line of lines) {
    length += line.length + 1
    if (length > maxChars) break
    kept.push(line)
  }
  return kept
}

/**
 * The memory block of a bot's instructions, from its `facts` as they are `now`; empty without any to show (design
 * §5.3). Profile facts first, the most important first, the least important dropping out past `maxProfileChars`; then
 * "Recently", log facts and notes under a week old ranked by `log2(importance) + createdAt / half-life`, cut at
 * `maxRecentChars`. Dates are the owner's, in `timeZone`.
 */
export function renderMemoryBlock(facts: readonly Fact[], { now, timeZone }: { now: number; timeZone: string }): string {
  const profile = facts
    .filter((fact) => fact.tier === 'profile')
    .sort((a, b) => b.importance - a.importance || a.id - b.id)
    .map((fact) => factLine(fact, timeZone))
  const rank = (fact: Fact) => Math.log2(fact.importance) + fact.createdAt.getTime() / rankHalfLifeMs
  const recent = facts
    .filter((fact) => fact.tier === 'log' || (fact.tier === 'note' && now - fact.createdAt.getTime() < noteLifetimeMs))
    .sort((a, b) => rank(b) - rank(a) || b.id - a.id)
    .map((fact) => factLine(fact, timeZone))
  const sections = [
    { title: 'Profile', lines: upTo(profile, maxProfileChars) },
    { title: 'Recently', lines: upTo(recent, maxRecentChars) },
  ].filter((section) => section.lines.length)
  if (!sections.length) return ''
  return [
    '<memory>',
    'What you remember from earlier conversations: your bot memory, only yours. Your instructions win over it. ' +
      'Each fact starts with its id in brackets; edit or forget a fact with update_state by its id.',
    ...sections.map((section) => `\n${section.title}:\n${section.lines.join('\n')}`),
    '</memory>',
  ].join('\n')
}

/**
 * The bot's memory block for its compaction epoch `epoch` (see `AgentRuntime`): rendered from its facts as they are
 * `now` the first time the epoch is asked for, then the same until the epoch changes, so the prompt stays cached. Facts
 * the bot writes meanwhile are in its history already.
 */
export async function frozenMemoryBlock(
  db: Db,
  botId: string,
  epoch: string | null,
  { now, timeZone }: { now: number; timeZone: string },
): Promise<string> {
  const [row] = await db.select({ memoryBlock: bots.memoryBlock }).from(bots).where(eq(bots.id, botId))
  if (row?.memoryBlock && row.memoryBlock.epoch === epoch) return row.memoryBlock.text
  const text = renderMemoryBlock(await listBotFacts(db, botId), { now, timeZone })
  await db.update(bots).set({ memoryBlock: { epoch, text } }).where(eq(bots.id, botId))
  return text
}
