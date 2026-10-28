import type { Clock, ClockTimer } from './ports/clock.ts'

/** A local time of day, `HH:MM` on a 24-hour clock. */
export type LocalTime = `${number}:${number}`

/** A local date and time of day, `YYYY-MM-DDTHH:MM` on a 24-hour clock, e.g. a reminder's in the owner's time zone. */
export type LocalDateTime = `${number}-${number}-${number}T${LocalTime}`

/** When a daily server job runs. */
export type DailyJob = {
  /** When it runs, in `timeZone`. */
  at: LocalTime
  /**
   * The IANA time zone `at` is in, read anew each time the job is scheduled (e.g. the owner's setting); `reschedule`
   * reads it again when it changes.
   */
  timeZone: () => string | Promise<string>
}

const hourMs = 60 * 60 * 1000

/** The offset of `timeZone` from UTC at `instant`, in ms (positive east of Greenwich). */
export function offsetAt(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  )
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!)
  return wall - (instant - (instant % 1000))
}

/** `at` as hours and minutes, or an error for anything but a time of day `HH:MM`. */
function parseLocalTime(at: LocalTime): [hour: number, minute: number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at)
  if (!match) throw new Error(`${at} isn't a time of day (HH:MM)`)
  return [Number(match[1]), Number(match[2])]
}

/** `local` as the instant UTC clocks read it, or an error for anything but a real `YYYY-MM-DDTHH:MM`. */
export function parseLocalDateTime(local: LocalDateTime): number {
  const invalid = () => new Error(`${local} isn't a local date and time (YYYY-MM-DDTHH:MM)`)
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(local)
  if (!match) throw invalid()
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number]
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  // Date.UTC rolls a day the month doesn't have (February 30th) into the next month.
  const date = new Date(wall)
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw invalid()
  return wall
}

/** The instant when clocks in `timeZone` read `wall` (a wall-clock time written as if it were UTC). */
export function instantOfWall(wall: number, timeZone: string): number {
  // At most one change of offset falls within a day either side; whichever offsets hold there, one or both fit.
  const before = offsetAt(wall - 24 * hourMs, timeZone)
  const after = offsetAt(wall + 24 * hourMs, timeZone)
  const fits = [before, after].map((offset) => wall - offset).filter((instant) => wall - offsetAt(instant, timeZone) === instant)
  // Twice as daylight saving time ends: the first. Skipped as it begins: past the gap, with the offset before it.
  return fits.length > 0 ? Math.min(...fits) : wall - before
}

/**
 * The instant when clocks in `timeZone` read `local`. A time skipped as daylight saving time begins moves past the
 * gap (02:30 becomes 03:30); one that happens twice as it ends is the first. Throws for an unknown time zone or
 * anything but a real `YYYY-MM-DDTHH:MM`.
 */
export function instantAt(local: LocalDateTime, timeZone: string): number {
  return instantOfWall(parseLocalDateTime(local), timeZone)
}

/** The first instant after `now` when clocks in `timeZone` read `at`. Throws for an unknown time zone. */
export function nextLocalTime(now: number, at: LocalTime, timeZone: string): number {
  const [hour, minute] = parseLocalTime(at)
  const today = new Date(now + offsetAt(now, timeZone))
  for (let day = 0; ; day++) {
    const instant = instantOfWall(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute), timeZone)
    if (instant > now) return instant
  }
}

/** A daily job as `ServerJobs` keeps it. */
type ScheduledJob = {
  /** Its next run's timer, unless it is running or being scheduled. */
  timer?: ClockTimer
  /** Counts schedulings, so a reschedule supersedes one still reading the time zone. */
  generation: number
  running: boolean
  schedule: () => Promise<void>
}

/**
 * The server's scheduled jobs (e.g. memory consolidation), run on the server's `Clock`. A job runs once at a time; a
 * failure is logged and the job runs again at its next time. Each next time is computed from the clock once the run
 * ends, never by replaying the past. A time zone that can't be read or isn't known schedules the job in UTC.
 */
export class ServerJobs {
  readonly #clock: Clock
  readonly #jobs = new Set<ScheduledJob>()
  /** Runs under way, which `close` waits for. */
  readonly #running = new Set<Promise<void>>()
  /** Schedulings reading their job's time zone, which `scheduled` waits for. */
  readonly #scheduling = new Set<Promise<void>>()
  #closed = false

  constructor({ clock }: { clock: Clock }) {
    this.#clock = clock
  }

  /** Runs `run` every day at `at` in the job's time zone, from now on. */
  daily(name: string, job: DailyJob, run: () => Promise<void>): void {
    parseLocalTime(job.at)
    const nextRun = async (now: number) => {
      try {
        return nextLocalTime(now, job.at, await job.timeZone())
      } catch (error) {
        console.error(`[jobs] Couldn't read ${name}'s time zone; scheduling it in UTC:`, error)
        return nextLocalTime(now, job.at, 'UTC')
      }
    }
    const scheduled: ScheduledJob = {
      generation: 0,
      running: false,
      schedule: async () => {
        const generation = ++scheduled.generation
        const now = this.#clock.now()
        const at = await nextRun(now)
        if (this.#closed || generation !== scheduled.generation) return
        scheduled.timer = this.#clock.setTimer(async () => {
          scheduled.timer = undefined
          if (this.#closed) return
          scheduled.running = true
          const running = run().catch((error) => console.error(`[jobs] ${name} failed:`, error))
          this.#running.add(running)
          await running
          this.#running.delete(running)
          scheduled.running = false
          await this.#track(scheduled.schedule())
        }, at - now)
      },
    }
    this.#jobs.add(scheduled)
    void this.#track(scheduled.schedule())
  }

  /**
   * Computes every job's next time again from now, e.g. once the owner's time zone changed. A job running now is
   * scheduled once its run ends, as always. Resolves once each has its next time.
   */
  reschedule(): Promise<void> {
    for (const job of this.#jobs) {
      if (job.running) continue
      if (job.timer) this.#clock.clearTimer(job.timer)
      job.timer = undefined
      void this.#track(job.schedule())
    }
    return this.scheduled()
  }

  /** Resolves once every job being scheduled (reading its time zone) has its next time. */
  async scheduled(): Promise<void> {
    while (this.#scheduling.size > 0) await Promise.all(this.#scheduling)
  }

  /** Stops every job; resolves once the runs under way have finished, none to be scheduled again. */
  async close(): Promise<void> {
    this.#closed = true
    for (const job of this.#jobs) if (job.timer) this.#clock.clearTimer(job.timer)
    this.#jobs.clear()
    await Promise.all([...this.#running, ...this.#scheduling])
  }

  async #track(scheduling: Promise<void>): Promise<void> {
    this.#scheduling.add(scheduling)
    try {
      await scheduling
    } finally {
      this.#scheduling.delete(scheduling)
    }
  }
}
