import { bots, type Db, type Fact, type FactTier, factTiers, memories, type MemoryScope } from '@openbot/db'
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

export { factTiers }
export type { Fact, FactTier, MemoryScope }

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

/** What changes of a fact: any of its text, tier and importance. */
export type FactChanges = { text?: string; tier?: FactTier; importance?: number }

/**
 * Who reaches for a fact by id, and so which facts they can reach. A bot, or the owner in the bot's Memory pane
 * (`{ botId }`), reaches its bot memory and shared memory, never another bot's bot memory; only `scope` when given. The
 * owner in Settings → Shared memory (`{ scope: 'shared' }`) reaches shared memory only.
 */
export type FactReach = { botId: string; scope?: MemoryScope } | { botId?: undefined; scope: 'shared' }

/** The facts `reach` reaches. */
const reachable = (reach: FactReach) => {
  const shared = eq(memories.scope, 'shared')
  if (reach.botId === undefined) return shared
  const own = and(eq(memories.scope, 'bot'), eq(memories.botId, reach.botId))
  return reach.scope === 'bot' ? own : reach.scope === 'shared' ? shared : or(own, shared)
}

/** The ownership check every way of reaching a fact by id goes through: fact `id`, if `reach` reaches it. */
const reachableFact = (reach: FactReach, id: number) => and(eq(memories.id, id), reachable(reach))

/** The bot's bot memory, oldest first. */
export async function listBotFacts(db: Db, botId: string): Promise<Fact[]> {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.scope, 'bot'), eq(memories.botId, botId)))
    .orderBy(asc(memories.id))
}

/** Shared memory, every bot's, oldest first. */
export async function listSharedFacts(db: Db): Promise<Fact[]> {
  return db.select().from(memories).where(eq(memories.scope, 'shared')).orderBy(asc(memories.id))
}

/**
 * The scope of fact `id` if bot `botId` can reach it (see `reachableFact`), else undefined: what the orchestrator
 * reviews an edit or forget of it under.
 */
export async function reachableFactScope(db: Db, botId: string, id: number): Promise<MemoryScope | undefined> {
  const [fact] = await db.select({ scope: memories.scope }).from(memories).where(reachableFact({ botId }, id))
  return fact?.scope
}

/**
 * Saves a fact the bot wrote itself, learned `now`: in its bot memory, or in shared memory, sourced to the bot with its
 * name as it is now. Throws `InvalidFactError` for an empty or too long text or an importance out of range.
 */
export async function writeFact(
  db: Db,
  bot: { id: string; name: string },
  { scope, tier, text, importance = defaultImportance }: { scope: MemoryScope; tier: FactTier; text: string; importance?: number },
  now: number,
): Promise<Fact> {
  const [fact] = await db
    .insert(memories)
    .values({
      scope,
      botId: scope === 'bot' ? bot.id : null,
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
 * Changes a fact `reach` reaches (for a bot, its bot memory or shared memory, whoever wrote it; only a fact of the scope
 * the orchestrator reviewed, when given) in place, keeping its id, scope, source and when it was learned. Throws
 * `NoSuchFactError` unless `reach` reaches it, and `InvalidFactError` for nothing to change or a bad text or importance.
 */
export async function editFact(
  db: Db,
  reach: FactReach,
  id: number,
  changes: FactChanges,
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
    .where(reachableFact(reach, id))
    .returning()
  if (!fact) throw new NoSuchFactError(id)
  return fact
}

/** Deletes a fact `reach` reaches for good, and answers it. Throws `NoSuchFactError` unless `reach` reaches it. */
export async function forgetFact(db: Db, reach: FactReach, id: number): Promise<Fact> {
  const [fact] = await db.delete(memories).where(reachableFact(reach, id)).returning()
  if (!fact) throw new NoSuchFactError(id)
  return fact
}

/**
 * Deletes the notes `reach` reaches that were learned at least `noteLifetimeMs` before `now`, for good; answers them,
 * oldest first.
 */
export async function expireNotes(db: Db, reach: FactReach, now: number): Promise<Fact[]> {
  const expired = await db
    .delete(memories)
    .where(and(reachable(reach), eq(memories.tier, 'note'), lte(memories.createdAt, new Date(now - noteLifetimeMs))))
    .returning()
  return expired.sort((a, b) => a.id - b.id)
}

/**
 * Breaks the freeze of every bot that sees `fact` (its bot for bot memory, every bot for shared memory): each renders
 * its memory block anew on its next run, without waiting for a compaction. What the owner changes takes effect at once;
 * bots' own changes don't need it, being in their history already, but a re-render shows them too. The block left is
 * stale, under an epoch no history has, and new each time, so a render that read the facts before this change can tell
 * it came too late (see `frozenMemoryBlock`).
 */
async function thawMemoryBlocks(db: Db, fact: Pick<Fact, 'scope' | 'botId'>): Promise<void> {
  await db
    .update(bots)
    .set({ memoryBlock: { epoch: `thawed-${uuidv7()}`, text: '' } })
    .where(fact.scope === 'bot' ? eq(bots.id, fact.botId!) : undefined)
}

/**
 * Saves a fact the owner adds, learned `now`, sourced to the owner: to bot `botId`'s bot memory, or to shared memory
 * without one. The bots that see it see it on their next run. Throws `InvalidFactError` for an empty or too long text
 * or an importance out of range.
 */
export async function addOwnerFact(
  db: Db,
  { botId, tier, text, importance = defaultImportance }: { botId?: string; tier: FactTier; text: string; importance?: number },
  now: number,
): Promise<Fact> {
  const [fact] = await db
    .insert(memories)
    .values({
      scope: botId === undefined ? 'shared' : 'bot',
      botId: botId ?? null,
      tier,
      content: checkedContent(text),
      importance: checkedImportance(importance),
      source: 'owner',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .returning()
  await thawMemoryBlocks(db, fact!)
  return fact!
}

/** `editFact` for the owner: the bots that see the fact see the change on their next run. */
export async function editOwnerFact(
  db: Db,
  reach: FactReach,
  id: number,
  changes: FactChanges,
  now: number,
): Promise<Fact> {
  const fact = await editFact(db, reach, id, changes, now)
  await thawMemoryBlocks(db, fact)
  return fact
}

/** `forgetFact` for the owner: the fact is gone from the prompts of the bots that saw it on their next run. */
export async function deleteOwnerFact(db: Db, reach: FactReach, id: number): Promise<void> {
  await thawMemoryBlocks(db, await forgetFact(db, reach, id))
}

/** Who a shared fact is from, as its tag shows: `the owner`, `Rex`, or `Rex (deleted)` once Rex is gone. */
export function factSourceName(fact: Pick<Fact, 'source' | 'sourceBotId' | 'sourceBotName'>): string {
  if (fact.source === 'owner') return 'the owner'
  const name = fact.sourceBotName ?? 'A bot'
  // As deleted bots' messages show (`deletedAuthorName`).
  return fact.sourceBotId ? name : `${name} (deleted)`
}

/**
 * `- [12] (learned 2026-10-25) fact`, the date in the owner's time zone; a shared fact is tagged with its source, as in
 * `- [12] (learned 2026-10-25) [via Rex] fact`.
 */
function factLine(fact: Fact, timeZone: string): string {
  const learned = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fact.createdAt)
  const via = fact.scope === 'shared' ? `[via ${factSourceName(fact)}] ` : ''
  return `- [${fact.id}] (learned ${learned}) ${via}${fact.content}`
}

/**
 * How many characters the profile facts among `facts` (one scope's) take in the memory block, all shown; past
 * `maxProfileChars`, the least important drop out.
 */
export function profileLength(facts: readonly Fact[], timeZone: string): number {
  const lines = facts.filter((fact) => fact.tier === 'profile').map((fact) => factLine(fact, timeZone))
  return Math.max(0, lines.reduce((length, line) => length + line.length + 1, -1))
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
 * The memory block of a bot's instructions, from its bot memory and shared memory (`facts`, any order) as they are
 * `now`; empty without any to show (design §5.3). Profile facts first, its bot memory's then shared memory's, each the
 * most important first, the least important dropping out past `maxProfileChars` per scope; then "Recently", log facts
 * and notes under a week old of both scopes ranked by `log2(importance) + createdAt / half-life`, cut at
 * `maxRecentChars`. Shared facts are tagged with their source. Dates are the owner's, in `timeZone`.
 */
export function renderMemoryBlock(facts: readonly Fact[], { now, timeZone }: { now: number; timeZone: string }): string {
  const profileOf = (scope: MemoryScope) =>
    upTo(
      facts
        .filter((fact) => fact.scope === scope && fact.tier === 'profile')
        .sort((a, b) => b.importance - a.importance || a.id - b.id)
        .map((fact) => factLine(fact, timeZone)),
      maxProfileChars,
    )
  const rank = (fact: Fact) => Math.log2(fact.importance) + fact.createdAt.getTime() / rankHalfLifeMs
  const recent = facts
    .filter((fact) => fact.tier === 'log' || (fact.tier === 'note' && now - fact.createdAt.getTime() < noteLifetimeMs))
    .sort((a, b) => rank(b) - rank(a) || b.id - a.id)
    .map((fact) => factLine(fact, timeZone))
  const sections = [
    { title: 'Profile', lines: [...profileOf('bot'), ...profileOf('shared')] },
    { title: 'Recently', lines: upTo(recent, maxRecentChars) },
  ].filter((section) => section.lines.length)
  if (!sections.length) return ''
  return [
    '<memory>',
    'What you remember from earlier conversations: your bot memory, only yours, and shared memory, which every bot ' +
      'knows and may change; shared facts are tagged [via whoever wrote them]. When they disagree: instructions > bot ' +
      'memory > shared memory. Each fact starts with its id in brackets; edit or forget a fact with update_state by its id.',
    ...sections.map((section) => `\n${section.title}:\n${section.lines.join('\n')}`),
    '</memory>',
  ].join('\n')
}

/**
 * The bot's memory block for its compaction epoch `epoch` (see `AgentRuntime`): rendered from its facts as they are
 * `now` the first time the epoch is asked for, then the same until the epoch changes, so the prompt stays cached. Facts
 * the bot writes meanwhile are in its history already; shared facts other bots write meanwhile wait for its next epoch.
 * The owner's changes don't wait: they thaw the frozen block (see `thawMemoryBlocks`).
 */
export async function frozenMemoryBlock(
  db: Db,
  botId: string,
  epoch: string | null,
  { now, timeZone }: { now: number; timeZone: string },
): Promise<string> {
  const [row] = await db.select({ memoryBlock: bots.memoryBlock }).from(bots).where(eq(bots.id, botId))
  if (row?.memoryBlock && row.memoryBlock.epoch === epoch) return row.memoryBlock.text
  const text = renderMemoryBlock([...(await listBotFacts(db, botId)), ...(await listSharedFacts(db))], { now, timeZone })
  // Kept only if the block is still the one read: an owner change meanwhile thawed it, and the next run renders anew.
  const unchanged = row?.memoryBlock ? sql`${bots.memoryBlock} = ${JSON.stringify(row.memoryBlock)}` : isNull(bots.memoryBlock)
  await db
    .update(bots)
    .set({ memoryBlock: { epoch, text } })
    .where(and(eq(bots.id, botId), unchanged))
  return text
}
