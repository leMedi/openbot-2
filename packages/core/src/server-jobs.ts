import type { Clock, ClockTimer } from './ports/clock.ts'

/** A local time of day, `HH:MM` on a 24-hour clock. */
export type LocalTime = `${number}:${number}`

/** When a daily server job runs. */
export type DailyJob = {
  /** When it runs, in `timeZone`. */
  at: LocalTime
  /** The IANA time zone `at` is in, read anew each time the job is scheduled, e.g. the owner's setting. */
  timeZone: () => string | Promise<string>
}

/** The offset of `timeZone` from UTC at `instant`, in ms (positive east of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
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

/** The first instant after `now` when clocks in `timeZone` read `at`. Throws for an unknown time zone. */
export function nextLocalTime(now: number, at: LocalTime, timeZone: string): number {
  const [hour, minute] = parseLocalTime(at)
  const today = new Date(now + offsetAt(now, timeZone))
  for (let day = 0; ; day++) {
    const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute)
    // The offset at the guess, then at the instant it gives, settles across a daylight saving time change.
    const guess = wall - offsetAt(wall, timeZone)
    const instant = wall - offsetAt(guess, timeZone)
    if (instant > now) return instant
  }
}

/**
 * The server's scheduled jobs (e.g. memory consolidation), run on the server's `Clock`. A job runs once at a time; a
 * failure is logged and the job runs again at its next time. Each next time is computed from the clock once the run
 * ends, never by replaying the past. A time zone that can't be read or isn't known schedules the job in UTC.
 */
export class ServerJobs {
  readonly #clock: Clock
  readonly #timers = new Set<ClockTimer>()
  /** Runs under way, which `close` waits for. */
  readonly #running = new Set<Promise<void>>()
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
    const schedule = async () => {
      const now = this.#clock.now()
      const at = await nextRun(now)
      if (this.#closed) return
      const timer = this.#clock.setTimer(async () => {
        this.#timers.delete(timer)
        if (this.#closed) return
        const running = run().catch((error) => console.error(`[jobs] ${name} failed:`, error))
        this.#running.add(running)
        await running
        this.#running.delete(running)
        await schedule()
      }, at - now)
      this.#timers.add(timer)
    }
    void schedule()
  }

  /** Stops every job; resolves once the runs under way have finished, none to be scheduled again. */
  async close(): Promise<void> {
    this.#closed = true
    for (const timer of this.#timers) this.#clock.clearTimer(timer)
    this.#timers.clear()
    await Promise.all(this.#running)
  }
}
