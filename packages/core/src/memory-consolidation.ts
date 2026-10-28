import { type Db, type FactTier, factTiers, settings } from '@openbot/db'
import { eq } from 'drizzle-orm'
import { listBots } from './bots.ts'
import {
  editFact,
  expireNotes,
  type Fact,
  type FactReach,
  forgetFact,
  InvalidFactError,
  listBotFacts,
  listSharedFacts,
  maxFactLength,
  maxProfileChars,
  NoSuchFactError,
  profileLength,
} from './memory.ts'
import type { Clock } from './ports/clock.ts'
import { ownerTimeZone } from './settings.ts'

/** The bot whose bot memory is consolidated. */
type BotRef = { id: string; name: string }

/** One scope consolidation works on: shared memory, or one bot's bot memory. */
type Scope = { scope: 'shared' } | { scope: 'bot'; bot: BotRef }

/** One change consolidation proposes, by fact ids. */
type ProposedChange =
  /** Facts that say the same thing (or recur) become one, kept under the oldest id. */
  | { change: 'merge'; ids: number[]; tier?: FactTier; importance?: number; text: string }
  | { change: 'edit'; id: number; tier?: FactTier; importance?: number; text?: string }
  | { change: 'remove'; id: number }

/** The settings key under which consolidation keeps when it last consolidated each scope (`shared`, or a bot's id). */
const consolidatedAtKey = 'memoryConsolidatedAt'

const scopeKey = (scope: Scope) => (scope.scope === 'shared' ? 'shared' : scope.bot.id)

/** What consolidation of `scope` reaches by id: that scope only, as the owner's and bots' changes are checked. */
const reachOf = (scope: Scope): FactReach => (scope.scope === 'shared' ? { scope: 'shared' } : { botId: scope.bot.id, scope: 'bot' })

/** `text` safe inside the prompt's tags and their attributes: what it says can't close one or open another. */
const escaped = (text: string) => text.replaceAll('<', '&lt;').replaceAll('"', '&quot;')

/** `- [12] (profile, 4, learned 2026-10-25, from Rex) The owner is called Sam.`, the date in the owner's time zone. */
function factLine(fact: Fact, timeZone: string): string {
  const learned = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fact.createdAt)
  const from = fact.source === 'owner' ? 'the owner' : (fact.sourceBotName ?? 'a bot')
  return `- [${fact.id}] (${fact.tier}, ${fact.importance}, learned ${learned}, from ${escaped(from)}) ${escaped(fact.content)}`
}

/** What consolidation tells the memory model about the job, for `scope`. */
function consolidationInstructions(scope: Scope): string {
  const whose =
    scope.scope === 'shared'
      ? "shared memory: the facts every one of the owner's bots knows, mostly about the owner"
      : `the bot memory of ${scope.bot.name}, one of the owner's bots: what it remembers about its own work`
  const contradicted =
    scope.scope === 'bot'
      ? `\n- Remove a fact of ${scope.bot.name}'s that a newer fact in <shared> contradicts. <shared> is read only: never change its facts.`
      : ''
  return `You tidy up ${whose}, once a night. You read its facts in <facts>, then answer changes that keep everything they say in fewer, clearer facts.

- Merge facts that say the same thing into one that keeps everything each of them said.
- Promote a log or note fact that keeps coming back (the same thing learned again and again) to profile: merge the recurring facts into one profile fact, or move a single one to profile.
- Keep the profile facts under ${maxProfileChars} characters in all: shorten their wording, merge them, or move the least important to log. Never drop information to fit.${contradicted}
- Never invent anything, never drop information otherwise, and only change facts listed in <facts>, by their id.

Tiers: profile for what is always true and relevant; log for a dated event, which fades but is kept; note for what matters for about a week. Importance from 1 (trivia) to 5 (essential).

Answer one change per line, and nothing else:
merge [<id>] [<id>]… [<profile|log|note>] [<1-5>]: <the merged fact, at most ${maxFactLength} characters>
edit [<id>] [<profile|log|note>] [<1-5>]: <the fact's new text, or nothing to keep it>
remove [<id>]
Answer NONE when memory is tidy already.`
}

/** What the memory model reads to consolidate `facts`, of `scope`; `shared` too, as context, for a bot's. */
function consolidationPrompt(scope: Scope, facts: readonly Fact[], shared: readonly Fact[], timeZone: string): string {
  return [
    `<facts scope="${scope.scope}" profile-characters="${profileLength(facts, timeZone)}">`,
    ...facts.map((fact) => factLine(fact, timeZone)),
    '</facts>',
    ...(scope.scope === 'bot' ? ['', '<shared>', ...(shared.length ? shared.map((fact) => factLine(fact, timeZone)) : ['(none)']), '</shared>'] : []),
  ].join('\n')
}

const tierPattern = factTiers.join('|')
const mergeLine = new RegExp(`^merge\\s+((?:\\[\\d+\\]\\s*)+?)(?:\\s*(${tierPattern}))?(?:\\s+([1-5]))?\\s*:\\s*(.+)$`, 'i')
const editLine = new RegExp(`^edit\\s+\\[(\\d+)\\](?:\\s+(${tierPattern}))?(?:\\s+([1-5]))?\\s*(?::\\s*(.*))?$`, 'i')
const removeLine = /^(?:remove|forget)\s+\[(\d+)\]\.?$/i

/** The changes in the memory model's answer, one per line it understood; other lines are ignored. */
function parseChanges(answer: string): ProposedChange[] {
  const changes: ProposedChange[] = []
  for (const raw of answer.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '').replace(/^`|`$/g, '')
    let match
    if ((match = mergeLine.exec(line))) {
      changes.push({
        change: 'merge',
        ids: [...match[1]!.matchAll(/\[(\d+)\]/g)].map((id) => Number(id[1])),
        ...(match[2] && { tier: match[2].toLowerCase() as FactTier }),
        ...(match[3] && { importance: Number(match[3]) }),
        text: match[4]!.trim(),
      })
    } else if ((match = editLine.exec(line))) {
      const text = match[4]?.trim()
      if (!match[2] && !match[3] && !text) continue
      changes.push({
        change: 'edit',
        id: Number(match[1]),
        ...(match[2] && { tier: match[2].toLowerCase() as FactTier }),
        ...(match[3] && { importance: Number(match[3]) }),
        ...(text && { text }),
      })
    } else if ((match = removeLine.exec(line))) {
      changes.push({ change: 'remove', id: Number(match[1]) })
    }
  }
  return changes
}

/** The ids of the facts `change` touches. */
const idsOf = (change: ProposedChange) => (change.change === 'merge' ? change.ids : [change.id])

/**
 * Whether `change` can be proposed for `facts` (its scope's): a merge names two facts or more, every id is one of
 * `facts` (one of another scope reads as one that doesn't exist), and none is `touched` by another change already.
 */
function proposable(change: ProposedChange, facts: ReadonlyMap<number, Fact>, touched: ReadonlySet<number>): boolean {
  const ids = idsOf(change)
  if (change.change === 'merge' && new Set(ids).size < 2) return false
  return ids.every((id) => facts.has(id) && !touched.has(id))
}

/** Whether `a` and `b`, one fact read twice, say the same: nothing changed it in between. */
const sameFact = (a: Fact, b: Fact) =>
  a.content === b.content && a.tier === b.tier && a.importance === b.importance && a.updatedAt.getTime() === b.updatedAt.getTime()

/** What `change` makes of `facts`, as the verification call reads it. */
function describeChange(change: ProposedChange, facts: ReadonlyMap<number, Fact>): string {
  if (change.change === 'remove') return `remove [${change.id}]`
  if (change.change === 'merge') {
    const [into] = [...change.ids].sort((a, b) => a - b)
    const { tier, importance } = mergedValues(change, facts)
    return `merge ${change.ids.map((id) => `[${id}]`).join(' ')} into [${into}] (${tier}, ${importance}): ${escaped(change.text)}`
  }
  const fact = facts.get(change.id)!
  return `edit [${change.id}] to (${change.tier ?? fact.tier}, ${change.importance ?? fact.importance}): ${escaped(change.text ?? fact.content)}`
}

/** A merge's tier and importance: as answered, else profile if any merged fact is, and the highest importance. */
function mergedValues(change: Extract<ProposedChange, { change: 'merge' }>, facts: ReadonlyMap<number, Fact>) {
  const merged = change.ids.map((id) => facts.get(id)!)
  const oldest = merged.reduce((a, b) => (a.id < b.id ? a : b))
  return {
    tier: change.tier ?? (merged.some((fact) => fact.tier === 'profile') ? 'profile' : oldest.tier),
    importance: change.importance ?? Math.max(...merged.map((fact) => fact.importance)),
  }
}

/** What the verification call is told about the job. */
function verificationInstructions(scope: Scope): string {
  const removal =
    scope.scope === 'bot'
      ? 'a removal drops only a fact that a newer fact in <shared> contradicts or that another kept fact says already'
      : 'a removal drops only a fact that another kept fact says already'
  return `You check the changes proposed to tidy up a memory of the owner's bots. <before> lists its facts as they are; <proposed>, the changes, numbered.

Accept a change only if nothing the facts said is lost or altered after it: a merge keeps everything each merged fact said; an edit keeps its fact's meaning (rewording it shorter, or changing its tier or importance, is fine); ${removal}. Reject anything that drops, alters or invents information.

Answer one line per change, and nothing else:
<number> accept
<number> reject: <why>`
}

/** What the verification call reads: the facts before, the shared facts for a bot's, and the changes numbered. */
function verificationPrompt(scope: Scope, facts: readonly Fact[], shared: readonly Fact[], described: readonly string[], timeZone: string): string {
  return [
    '<before>',
    ...facts.map((fact) => factLine(fact, timeZone)),
    '</before>',
    ...(scope.scope === 'bot' ? ['', '<shared>', ...(shared.length ? shared.map((fact) => factLine(fact, timeZone)) : ['(none)']), '</shared>'] : []),
    '',
    '<proposed>',
    ...described.map((line, index) => `${index + 1}. ${line}`),
    '</proposed>',
  ].join('\n')
}

/** The verdicts in the verification call's answer, by change number: whether each was accepted. */
function parseVerdicts(answer: string): Map<number, boolean> {
  const verdicts = new Map<number, boolean>()
  for (const raw of answer.split('\n')) {
    const match = /^\s*[-*]?\s*(\d+)[.):]?\s+(accept(?:ed)?|reject(?:ed)?)\b/i.exec(raw)
    if (!match) continue
    const number = Number(match[1])
    if (!verdicts.has(number)) verdicts.set(number, match[2]!.toLowerCase().startsWith('accept'))
  }
  return verdicts
}

export type MemoryConsolidationOptions = {
  db: Db
  /** The server's time: notes expire by it, and changes are dated by it. */
  clock: Clock
  /** The memory model's ref, as for extraction; undefined while it has no working provider, when only notes expire. */
  model(): Promise<string | undefined>
  /** One text request to model `ref`; throws when it fails. */
  complete(ref: string, request: { systemPrompt: string; prompt: string }): Promise<string>
}

/**
 * Consolidation (design §5.3): the nightly tidy-up of memory, a server job. Each run deletes the notes older than a week,
 * then, on the memory model, consolidates each scope (shared memory, then each bot's bot memory) whose facts changed
 * since that scope was last consolidated (a bot's also once shared memory did): one call proposes changes by fact id, a second verifies them, and only those it
 * accepts are applied, through the ownership check of the scope worked on. A failed call is tried once more, then the
 * scope waits for the next run. No change is reviewed or audited. Nothing runs without a bot: no one reads memory then.
 */
export class MemoryConsolidation {
  readonly #options: MemoryConsolidationOptions

  constructor(options: MemoryConsolidationOptions) {
    this.#options = options
  }

  /** Consolidates memory once, now. */
  async run(): Promise<void> {
    const { db, clock } = this.#options
    const now = clock.now()
    const bots = await listBots(db)
    if (!bots.length) return
    const scopes: Scope[] = [{ scope: 'shared' }, ...bots.map((bot) => ({ scope: 'bot' as const, bot: { id: bot.id, name: bot.name } }))]
    for (const scope of scopes) await expireNotes(db, reachOf(scope), now)
    const ref = await this.#options.model()
    if (!ref) return
    const timeZone = await ownerTimeZone(db)
    const consolidatedAt = await readConsolidatedAt(db)
    const changedSince = (facts: readonly Fact[], since: number) => facts.some((fact) => fact.updatedAt.getTime() > since)
    for (const scope of scopes) {
      const facts = await this.#factsOf(scope)
      const since = consolidatedAt[scopeKey(scope)]
      // A bot's memory counts as changed once shared memory did too: a newer shared fact may contradict one of its own.
      const changed =
        since === undefined || changedSince(facts, since) || (scope.scope === 'bot' && changedSince(await listSharedFacts(db), since))
      if (!facts.length || !changed) continue
      try {
        if (!(await this.#consolidate(scope, facts, ref, now, timeZone))) continue
      } catch (error) {
        // Not the model's: e.g. the database failed. The scope waits for the next run.
        console.error(`[memory] Consolidation of ${describeScope(scope)} failed:`, error)
        continue
      }
      // Stamped with the time the run started, as its changes are: they don't count as changes the next night.
      consolidatedAt[scopeKey(scope)] = now
      await writeConsolidatedAt(db, consolidatedAt, bots.map((bot) => bot.id))
    }
  }

  /** The facts of `scope`, oldest first. */
  #factsOf(scope: Scope): Promise<Fact[]> {
    return scope.scope === 'shared' ? listSharedFacts(this.#options.db) : listBotFacts(this.#options.db, scope.bot.id)
  }

  /**
   * Proposes, verifies and applies changes to `facts`, the facts of `scope`, dated `now`; false when a call failed and
   * the scope waits for the next run.
   */
  async #consolidate(scope: Scope, facts: readonly Fact[], ref: string, now: number, timeZone: string): Promise<boolean> {
    const { db } = this.#options
    const shared = scope.scope === 'bot' ? await listSharedFacts(db) : []
    const answer = await this.#ask(scope, ref, { systemPrompt: consolidationInstructions(scope), prompt: consolidationPrompt(scope, facts, shared, timeZone) })
    if (answer === undefined) return false
    const byId = new Map(facts.map((fact) => [fact.id, fact]))
    const proposed: ProposedChange[] = []
    const touched = new Set<number>()
    for (const change of parseChanges(answer)) {
      if (!proposable(change, byId, touched)) continue
      for (const id of idsOf(change)) touched.add(id)
      proposed.push(change)
    }
    if (!proposed.length) return true
    const described = proposed.map((change) => describeChange(change, byId))
    const verdict = await this.#ask(scope, ref, {
      systemPrompt: verificationInstructions(scope),
      prompt: verificationPrompt(scope, facts, shared, described, timeZone),
    })
    if (verdict === undefined) return false
    const verdicts = parseVerdicts(verdict)
    // A change the verification call answered nothing for counts as rejected.
    for (const [index, change] of proposed.entries()) if (verdicts.get(index + 1)) await this.#apply(scope, change, byId, now)
    return true
  }

  /**
   * Applies `change` through the ownership check of `scope` (as `update_state` changes facts), dated `now`; leaves it
   * when it can't be, e.g. a fact gone or changed meanwhile.
   */
  async #apply(scope: Scope, change: ProposedChange, facts: ReadonlyMap<number, Fact>, now: number): Promise<void> {
    const { db } = this.#options
    const reach = reachOf(scope)
    // As read when the change was proposed: one changed meanwhile, e.g. by the owner, isn't overwritten by stale text.
    const current = new Map((await this.#factsOf(scope)).map((fact) => [fact.id, fact]))
    for (const id of idsOf(change)) {
      const [before, after] = [facts.get(id)!, current.get(id)]
      if (!after || !sameFact(before, after)) return
    }
    try {
      if (change.change === 'remove') await forgetFact(db, reach, change.id)
      else if (change.change === 'edit') await editFact(db, reach, change.id, { text: change.text, tier: change.tier, importance: change.importance }, now)
      else {
        const [into, ...others] = [...new Set(change.ids)].sort((a, b) => a - b)
        await editFact(db, reach, into!, { text: change.text, ...mergedValues(change, facts) }, now)
        for (const id of others) {
          await forgetFact(db, reach, id).catch((error: unknown) => {
            // Gone meanwhile: merged all the same.
            if (!(error instanceof NoSuchFactError)) throw error
          })
        }
      }
    } catch (error) {
      if (!(error instanceof NoSuchFactError || error instanceof InvalidFactError)) throw error
    }
  }

  /** The answer to `request` on model `ref`; a failed call is tried once more, then `scope` is skipped and this answers undefined. */
  async #ask(scope: Scope, ref: string, request: { systemPrompt: string; prompt: string }): Promise<string | undefined> {
    let failure: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.#options.complete(ref, request)
      } catch (error) {
        failure = error
      }
    }
    console.error(`[memory] Skipped consolidating ${describeScope(scope)}: ${failure instanceof Error ? failure.message : String(failure)}`)
    return undefined
  }
}

const describeScope = (scope: Scope) => (scope.scope === 'shared' ? 'shared memory' : `${scope.bot.name}'s bot memory`)

/** When each scope was last consolidated (ms), by `shared` or bot id. */
async function readConsolidatedAt(db: Db): Promise<Record<string, number>> {
  const [row] = await db.select().from(settings).where(eq(settings.key, consolidatedAtKey))
  return { ...(row?.value as Record<string, number> | undefined) }
}

/** Keeps `consolidatedAt`, without the bots no longer in `botIds`. */
async function writeConsolidatedAt(db: Db, consolidatedAt: Record<string, number>, botIds: readonly string[]): Promise<void> {
  const value = Object.fromEntries(Object.entries(consolidatedAt).filter(([key]) => key === 'shared' || botIds.includes(key)))
  await db
    .insert(settings)
    .values({ key: consolidatedAtKey, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}
