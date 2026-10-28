import { type Db, type Routine, type RoutineAuthor, type RoutineRun, routineRuns, routines } from '@openbot/db'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, ne, notInArray } from 'drizzle-orm'
import { recordUnreviewed } from './orchestrator.ts'
import type { Clock, ClockTimer } from './ports/clock.ts'
import type { BotInput } from './ports/agent-runtime.ts'
import { InvalidScheduleError, nextOccurrence, parseSchedule, type Schedule } from './schedules.ts'
import { instantAt } from './server-jobs.ts'

export type { Routine, RoutineAuthor, RoutineRun }

/** A bot has at most this many routines, reminders that fired included. */
export const maxRoutinesPerBot = 20
/** A routine's name is at most this many characters. */
export const maxRoutineNameLength = 100
/** A routine's prompt (its instruction) is at most this many characters. */
export const maxRoutinePromptLength = 10_000
/** A fire missed while the server was down runs if it is less late than this; otherwise it is recorded as missed. */
export const missedFireGraceMs = 60 * 60 * 1000
/** The runs kept per routine, newest. */
export const keptRunsPerRoutine = 100

/** The id of the input a routine's run wakes its bot with, which tells the run's end and messages apart. */
const inputIdOf = (runId: number) => `routine-run:${runId}`
const runIdOf = (inputId: string) => (/^routine-run:(\d+)$/.exec(inputId) ? Number(inputId.slice('routine-run:'.length)) : undefined)

/**
 * The answer to any routine id that can't be reached: one that never existed, is gone, or is another bot's. They
 * answer the same, so a bot learns nothing of others' routines.
 */
export class NoSuchRoutineError extends Error {
  constructor() {
    super('There is no such routine.')
    this.name = 'NoSuchRoutineError'
  }
}

/** A routine's name, prompt or schedule that can't be written, or one routine too many. */
export class InvalidRoutineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRoutineError'
  }
}

/** A routine as the owner sees it: with whether its latest run is going on. */
export type RoutineState = Routine & { running: boolean }

/** A routine to create: enabled unless `enabled` is false. */
export type NewRoutine = { name: string; prompt: string; schedule: string; enabled?: boolean }
/** What changes of a routine: any of its name, prompt and schedule. */
export type RoutineChanges = Partial<Pick<NewRoutine, 'name' | 'prompt' | 'schedule'>>

/** What `Routines` runs against. */
export type RoutinesOptions = {
  db: Db
  clock: Clock
  /** The owner's time zone, which cron schedules and reminders read. */
  timeZone(): Promise<string>
  /** Queues a background-lane input for the bot (`AgentRuntime.wake`). */
  wake(botId: string, input: BotInput): Promise<void>
  /** Whether the bot's input is queued or running. */
  pending(botId: string, inputId: string): boolean
  /** A routine was created or changed, its runs included. */
  onRoutine?(routine: RoutineState): void
  /** A routine was deleted, its runs with it. */
  onRoutineDeleted?(routine: Routine): void
  /** A run was recorded or changed; awaited, so runs are told of in order. */
  onRun?(routine: Routine, run: RoutineRun): void | Promise<void>
}

function checkedName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new InvalidRoutineError('A routine needs a name.')
  if (trimmed.length > maxRoutineNameLength) throw new InvalidRoutineError(`A routine's name is at most ${maxRoutineNameLength} characters.`)
  return trimmed
}

function checkedPrompt(prompt: string): string {
  const trimmed = prompt.trim()
  if (!trimmed) throw new InvalidRoutineError('A routine needs an instruction.')
  if (trimmed.length > maxRoutinePromptLength) throw new InvalidRoutineError(`A routine's instruction is at most ${maxRoutinePromptLength} characters.`)
  return trimmed
}

function checkedSchedule(schedule: string): { text: string; schedule: Schedule } {
  try {
    return { text: schedule.trim(), schedule: parseSchedule(schedule) }
  } catch (error) {
    if (error instanceof InvalidScheduleError) throw new InvalidRoutineError(error.message)
    throw error
  }
}

/** `instant` as the owner's clocks read it, e.g. `2026-10-29 09:00`. */
function localTime(instant: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/** How late a run is, in words. */
function lateness(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'on time'
  return `${minutes} minute${minutes === 1 ? '' : 's'} late`
}

/** How long a routine that couldn't be fired (e.g. the database failed) waits before it is tried again. */
const retryAfterMs = 60 * 1000

/**
 * The fire of `schedule` that a routine due at `due` runs at `now`: the latest due by `now`, as fires missed while the
 * server was down collapse into one. When none is under `missedFireGraceMs` late, `due` itself, to be recorded as missed.
 */
function latestFire(schedule: Schedule, due: number, now: number, timeZone: string): number {
  if (schedule.kind === 'at' || now - due < 0) return due
  if (schedule.kind === 'every') return due + Math.floor((now - due) / schedule.ms) * schedule.ms
  // Only the last hour matters: a fire before it is missed either way.
  let latest = now - due < missedFireGraceMs ? due : undefined
  for (let next = nextOccurrence(schedule, latest ?? now - missedFireGraceMs, timeZone); next !== undefined && next <= now; next = nextOccurrence(schedule, next, timeZone)) {
    latest = next
  }
  return latest ?? due
}

/** Writes a failed run to its bot's audit log, under `routine_change`; never reviewed. */
function auditFailure(db: Db, routine: Routine, run: RoutineRun, error: string): Promise<void> {
  return recordUnreviewed(db, routine.botId, {
    kind: 'routine',
    surface: 'routine_change',
    tool: 'routine',
    input: { routineId: routine.id, name: routine.name, runId: run.id, status: 'failed', error },
  })
}

/**
 * What the bot reads when its routine fires (design §5.4): who wrote it (the owner's standing instruction, or the bot's
 * own note, which carries no more authority than its notes), the prompt, when it was due and how late it is.
 */
export function routineCue(routine: Pick<Routine, 'name' | 'prompt' | 'createdBy'>, run: { scheduledFor: number; firedAt: number; test: boolean }, timeZone: string): string {
  const who = routine.createdBy === 'owner' ? 'set by you' : 'your own note'
  const when = run.test
    ? `The owner started this run now, as a test (${localTime(run.firedAt, timeZone)}, ${timeZone}).`
    : `It was due at ${localTime(run.scheduledFor, timeZone)} (${timeZone}); this run is ${lateness(run.firedAt - run.scheduledFor)}.`
  return [
    `[routine ${JSON.stringify(routine.name)}, ${who}]`,
    routine.prompt,
    when,
    'Message the owner only if there is something worth telling them; otherwise end without a message.',
  ].join('\n\n')
}

/**
 * Bots' routines (design §5.4): kept in the database, managed by the owner (and, through `update_state`, by the bot
 * itself), and fired by one timer on the server's clock, set for the earliest `next_run_at`. A fire queues a
 * background-lane input in the bot's conversation; a routine whose previous run is still queued or running is skipped,
 * a fire missed while the server was down runs once if under an hour late (several collapse into one) and is recorded
 * as missed otherwise, and the next run is always computed from now. A reminder (`at`) is disabled once it fired.
 *
 * Every change and fire goes through one chain, in order; only noting a run's message doesn't wait for it. Each method takes the bot whose routine it is: an id of
 * another bot's routine answers as a missing one does.
 */
export class Routines {
  readonly #options: RoutinesOptions
  #chain: Promise<unknown> = Promise.resolve()
  #timer?: ClockTimer
  #closed = false

  constructor(options: RoutinesOptions) {
    this.#options = options
  }

  /**
   * Starts firing: fires missed while the server was down are handled at once, and runs left `running` whose input the
   * runtime no longer holds (their end was lost) are recorded as ran. Call it once the runtime has taken on its queue.
   */
  start(): Promise<void> {
    return this.#serially(async () => {
      const { db } = this.#options
      const running = await db
        .select({ run: routineRuns, botId: routines.botId })
        .from(routineRuns)
        .innerJoin(routines, eq(routines.id, routineRuns.routineId))
        .where(eq(routineRuns.status, 'running'))
      const lost = running.filter(({ run, botId }) => !this.#options.pending(botId, inputIdOf(run.id))).map(({ run }) => run.id)
      if (lost.length) await db.update(routineRuns).set({ status: 'ran', finishedAt: new Date(this.#now()) }).where(inArray(routineRuns.id, lost))
      await this.#fireDue()
    })
  }

  /** Stops firing; resolves once the change or fire under way is done. */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) this.#options.clock.clearTimer(this.#timer)
    this.#timer = undefined
    await this.#chain.catch(() => {})
  }

  /** Resolves once every change and fire asked so far is done. */
  async idle(): Promise<void> {
    await this.#serially(async () => {})
  }

  /** The bot's routines, oldest first. */
  async list(botId: string): Promise<RoutineState[]> {
    const rows = await this.#options.db.select().from(routines).where(eq(routines.botId, botId)).orderBy(asc(routines.createdAt), asc(routines.id))
    return this.#withState(rows)
  }

  /** The bot's routine `id`, or `NoSuchRoutineError`. */
  async get(botId: string, id: string): Promise<RoutineState> {
    const [state] = await this.#withState([await this.#routine(botId, id)])
    return state!
  }

  /** The routine's runs, newest first. */
  async runs(botId: string, id: string): Promise<RoutineRun[]> {
    await this.#routine(botId, id)
    return this.#options.db.select().from(routineRuns).where(eq(routineRuns.routineId, id)).orderBy(desc(routineRuns.id))
  }

  /** Creates a routine for the bot, enabled unless said otherwise; at most `maxRoutinesPerBot`. */
  create(botId: string, values: NewRoutine, author: RoutineAuthor): Promise<RoutineState> {
    return this.#serially(async () => {
      const name = checkedName(values.name)
      const prompt = checkedPrompt(values.prompt)
      const { text, schedule } = checkedSchedule(values.schedule)
      const { db } = this.#options
      const [{ routines: existing } = { routines: 0 }] = await db.select({ routines: count() }).from(routines).where(eq(routines.botId, botId))
      if (existing >= maxRoutinesPerBot) throw new InvalidRoutineError(`A bot can have at most ${maxRoutinesPerBot} routines; delete one first.`)
      const enabled = values.enabled ?? true
      const now = this.#now()
      const nextRunAt = enabled ? await this.#firstRun(schedule) : null
      const [routine] = await db
        .insert(routines)
        .values({ botId, name, prompt, schedule: text, enabled, nextRunAt: nextRunAt === null ? null : new Date(nextRunAt), createdBy: author, createdAt: new Date(now), updatedAt: new Date(now) })
        .returning()
      return this.#changed(routine!)
    })
  }

  /** Changes the routine's name, prompt or schedule; it becomes `author`'s. A new schedule runs next from now. */
  update(botId: string, id: string, changes: RoutineChanges, author: RoutineAuthor): Promise<RoutineState> {
    return this.#serially(async () => {
      const routine = await this.#routine(botId, id)
      const name = changes.name === undefined ? routine.name : checkedName(changes.name)
      const prompt = changes.prompt === undefined ? routine.prompt : checkedPrompt(changes.prompt)
      const rescheduled = changes.schedule !== undefined && changes.schedule.trim() !== routine.schedule
      const { text, schedule } = checkedSchedule(changes.schedule ?? routine.schedule)
      let { nextRunAt } = routine
      if (rescheduled && routine.enabled) nextRunAt = new Date(await this.#firstRun(schedule))
      return this.#changed(await this.#save(routine.id, { name, prompt, schedule: text, nextRunAt, createdBy: author, updatedAt: new Date(this.#now()) }))
    })
  }

  /** Pauses the routine: it doesn't fire until resumed. Doesn't change whose it is. */
  pause(botId: string, id: string): Promise<RoutineState> {
    return this.#serially(async () => {
      const routine = await this.#routine(botId, id)
      return this.#changed(await this.#save(routine.id, { enabled: false, nextRunAt: null, updatedAt: new Date(this.#now()) }))
    })
  }

  /** Resumes the routine, its next run computed from now; a reminder whose time has passed can't be. */
  resume(botId: string, id: string): Promise<RoutineState> {
    return this.#serially(async () => {
      const routine = await this.#routine(botId, id)
      if (routine.enabled) return (await this.#withState([routine]))[0]!
      const nextRunAt = await this.#firstRun(checkedSchedule(routine.schedule).schedule)
      return this.#changed(await this.#save(routine.id, { enabled: true, nextRunAt: new Date(nextRunAt), updatedAt: new Date(this.#now()) }))
    })
  }

  /** Deletes the routine and its runs for good. */
  delete(botId: string, id: string): Promise<void> {
    return this.#serially(async () => {
      const routine = await this.#routine(botId, id)
      await this.#options.db.delete(routines).where(eq(routines.id, routine.id))
      this.#options.onRoutineDeleted?.(routine)
      await this.#arm()
    })
  }

  /**
   * Fires the routine now, paused or not, as a test: it doesn't move its next run. Skipped, as a scheduled fire is,
   * while its previous run is still queued or running. Returns the run.
   */
  testRun(botId: string, id: string): Promise<RoutineRun> {
    return this.#serially(async () => {
      const routine = await this.#routine(botId, id)
      const now = this.#now()
      const run = (await this.#overlaps(routine))
        ? await this.#record(routine, { scheduledFor: now, status: 'skipped_overlap', test: true })
        : await this.#fire(routine, now, true)
      this.#options.onRoutine?.((await this.#withState([routine]))[0]!)
      return run
    })
  }

  /** Computes every routine's next run again, e.g. once the owner's time zone changed: a reminder keeps its local time. */
  reschedule(): Promise<void> {
    return this.#serially(async () => {
      const { db } = this.#options
      const timeZone = await this.#options.timeZone()
      const now = this.#now()
      for (const routine of await db.select().from(routines).where(eq(routines.enabled, true))) {
        // Already due: it fires next, as it would have, and its next run is computed from then.
        if (routine.nextRunAt && routine.nextRunAt.getTime() <= now) continue
        let schedule: Schedule
        try {
          schedule = parseSchedule(routine.schedule)
        } catch {
          continue
        }
        if (schedule.kind === 'every') continue
        // A reminder whose local time has now passed is due: it fires, or is missed, as after a restart.
        const next = schedule.kind === 'at' ? instantAt(schedule.local, timeZone) : nextOccurrence(schedule, now, timeZone)
        const updated = await this.#save(routine.id, { nextRunAt: next === undefined ? null : new Date(next) })
        this.#options.onRoutine?.((await this.#withState([updated]))[0]!)
      }
      await this.#fireDue()
    })
  }

  /** The runtime's word that a routine run's input ended for good: answered (`ran`) or `failed`, which is audited. */
  settled(inputId: string, outcome: { status: 'answered' } | { status: 'failed'; error: string }): Promise<void> {
    const runId = runIdOf(inputId)
    if (runId === undefined) return Promise.resolve()
    return this.#serially(async () => {
      const { db } = this.#options
      const [run] = await db
        .update(routineRuns)
        .set({ status: outcome.status === 'answered' ? 'ran' : 'failed', finishedAt: new Date(this.#now()) })
        .where(and(eq(routineRuns.id, runId), eq(routineRuns.status, 'running')))
        .returning()
      if (!run) return
      const [routine] = await db.select().from(routines).where(eq(routines.id, run.routineId))
      if (!routine) return
      if (outcome.status === 'failed') {
        await auditFailure(db, routine, run, outcome.error)
      }
      await this.#options.onRun?.(routine, run)
      this.#options.onRoutine?.((await this.#withState([routine]))[0]!)
    })
  }

  /** Notes the bot's message to the owner, sent by the run of input `inputId` if it is a routine's: its first one. */
  async sentMessage(inputId: string | undefined, messageId: string): Promise<void> {
    const runId = inputId === undefined ? undefined : runIdOf(inputId)
    if (runId === undefined) return
    const { db } = this.#options
    const [run] = await db
      .update(routineRuns)
      .set({ messageId })
      .where(and(eq(routineRuns.id, runId), isNull(routineRuns.messageId)))
      .returning()
    if (!run) return
    const [routine] = await db.select().from(routines).where(eq(routines.id, run.routineId))
    if (routine) await this.#options.onRun?.(routine, run)
  }

  #now(): number {
    return this.#options.clock.now()
  }

  /** Runs `work` after every change and fire asked before it. */
  #serially<T>(work: () => Promise<T>): Promise<T> {
    const done = this.#chain.then(work, work)
    this.#chain = done.catch(() => {})
    return done
  }

  async #routine(botId: string, id: string): Promise<Routine> {
    const [routine] = await this.#options.db
      .select()
      .from(routines)
      .where(and(eq(routines.id, id), eq(routines.botId, botId)))
    if (!routine) throw new NoSuchRoutineError()
    return routine
  }

  async #save(id: string, values: Partial<Routine>): Promise<Routine> {
    const [routine] = await this.#options.db.update(routines).set(values).where(eq(routines.id, id)).returning()
    return routine!
  }

  async #withState(rows: Routine[]): Promise<RoutineState[]> {
    if (!rows.length) return []
    const running = await this.#options.db
      .select({ routineId: routineRuns.routineId })
      .from(routineRuns)
      .where(and(eq(routineRuns.status, 'running'), inArray(routineRuns.routineId, rows.map((row) => row.id))))
    const busy = new Set(running.map((run) => run.routineId))
    return rows.map((row) => ({ ...row, running: busy.has(row.id) }))
  }

  /** Tells of the change and sets the timer again; returns the routine as the owner sees it. */
  async #changed(routine: Routine): Promise<RoutineState> {
    const [state] = await this.#withState([routine])
    this.#options.onRoutine?.(state!)
    await this.#arm()
    return state!
  }

  /** When `schedule` fires first from now; a reminder whose time has passed can't be enabled. */
  async #firstRun(schedule: Schedule): Promise<number> {
    const next = nextOccurrence(schedule, this.#now(), await this.#options.timeZone())
    if (next === undefined) throw new InvalidRoutineError(schedule.kind === 'at' ? 'That time has passed; pick a later one.' : 'This schedule never fires.')
    return next
  }

  /** Sets the one timer for the earliest next run, at least `minDelayMs` from now (e.g. after a fire that failed). */
  async #arm(minDelayMs = 0): Promise<void> {
    if (this.#closed) return
    const { clock, db } = this.#options
    if (this.#timer) clock.clearTimer(this.#timer)
    this.#timer = undefined
    const [earliest] = await db
      .select({ at: routines.nextRunAt })
      .from(routines)
      .where(and(eq(routines.enabled, true), isNotNull(routines.nextRunAt)))
      .orderBy(asc(routines.nextRunAt))
      .limit(1)
    if (!earliest?.at) return
    this.#timer = clock.setTimer(() => {
      this.#timer = undefined
      return this.#serially(() => this.#fireDue()).catch((error) => console.error("[routines] Couldn't fire routines:", error))
    }, Math.max(earliest.at.getTime() - this.#now(), minDelayMs))
  }

  /** Fires, skips or records as missed every routine due by now, then sets the timer for the next. */
  async #fireDue(): Promise<void> {
    if (this.#closed) return
    const { db } = this.#options
    const now = this.#now()
    const due = await db
      .select()
      .from(routines)
      .where(and(eq(routines.enabled, true), lte(routines.nextRunAt, new Date(now))))
      .orderBy(asc(routines.nextRunAt))
    let failed = false
    for (const routine of due) {
      try {
        await this.#fireScheduled(routine, now)
      } catch (error) {
        failed = true
        console.error(`[routines] Couldn't fire routine ${routine.id}:`, error)
      }
    }
    // A routine that couldn't be fired is still due: it is tried again in a minute, not at once over and over.
    await this.#arm(failed ? retryAfterMs : 0)
  }

  /** Handles the due `routine`: its latest fire due by `now` runs, unless it overlaps or is too late. */
  async #fireScheduled(routine: Routine, now: number): Promise<void> {
    const timeZone = await this.#options.timeZone()
    let schedule: Schedule
    try {
      schedule = parseSchedule(routine.schedule)
    } catch {
      await this.#save(routine.id, { enabled: false, nextRunAt: null })
      return
    }
    const scheduledFor = latestFire(schedule, routine.nextRunAt!.getTime(), now, timeZone)
    if (now - scheduledFor >= missedFireGraceMs) await this.#record(routine, { scheduledFor, status: 'missed' })
    else if (await this.#overlaps(routine)) await this.#record(routine, { scheduledFor, status: 'skipped_overlap' })
    else await this.#fire(routine, scheduledFor, false)
    // A reminder fires once; it stays, disabled, with its history.
    const next = schedule.kind === 'at' ? undefined : nextOccurrence(schedule, now, timeZone)
    const updated = await this.#save(routine.id, next === undefined ? { enabled: false, nextRunAt: null } : { nextRunAt: new Date(next) })
    this.#options.onRoutine?.((await this.#withState([updated]))[0]!)
  }

  /** Whether the routine's previous run is still queued or running. */
  async #overlaps(routine: Routine): Promise<boolean> {
    const running = await this.#options.db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routine.id), eq(routineRuns.status, 'running')))
    return running.some((run) => this.#options.pending(routine.botId, inputIdOf(run.id)))
  }

  /** Queues the routine's run in its bot's background lane; a run that can't be queued failed, and is audited. */
  async #fire(routine: Routine, scheduledFor: number, test: boolean): Promise<RoutineRun> {
    const firedAt = this.#now()
    const run = await this.#record(routine, { scheduledFor, firedAt, status: 'running', test })
    const text = routineCue(routine, { scheduledFor, firedAt, test }, await this.#options.timeZone())
    try {
      await this.#options.wake(routine.botId, { lane: 'background', text, id: inputIdOf(run.id) })
      return run
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const [failed] = await this.#options.db.update(routineRuns).set({ status: 'failed', finishedAt: new Date(this.#now()) }).where(eq(routineRuns.id, run.id)).returning()
      await auditFailure(this.#options.db, routine, run, message)
      await this.#options.onRun?.(routine, failed!)
      return failed!
    }
  }

  /** Writes a run of the routine, keeping its newest `keptRunsPerRoutine`, and any older one still running. */
  async #record(
    routine: Routine,
    values: { scheduledFor: number; status: RoutineRun['status']; firedAt?: number; test?: boolean },
  ): Promise<RoutineRun> {
    const { db } = this.#options
    const done = values.status !== 'running'
    const [run] = await db
      .insert(routineRuns)
      .values({
        routineId: routine.id,
        scheduledFor: new Date(values.scheduledFor),
        firedAt: values.firedAt === undefined ? null : new Date(values.firedAt),
        status: values.status,
        finishedAt: done ? new Date(this.#now()) : null,
        test: values.test ?? false,
      })
      .returning()
    const kept = db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id))
      .orderBy(desc(routineRuns.id))
      .limit(keptRunsPerRoutine)
    // A run going on is kept until it ends: a later fire must still see it to skip.
    await db
      .delete(routineRuns)
      .where(and(eq(routineRuns.routineId, routine.id), ne(routineRuns.status, 'running'), notInArray(routineRuns.id, kept)))
    await this.#options.onRun?.(routine, run!)
    return run!
  }
}
