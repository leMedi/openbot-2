import type { Clock, ClockTimer } from '../ports/clock.ts'

/** A pending timer: when it fires, and its order among timers due at once. */
type Timer = { at: number; seq: number; run: () => void | Promise<void> }

/** Lets callbacks started just before, e.g. a job scheduling itself, start their timers. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * A `Clock` that stands still until the test moves it forward, firing the timers that fall due on the way, in order,
 * each once the one before has settled (its callback's promise, e.g. a server job's run).
 */
export function createFakeClock(start: Date | number = Date.now()) {
  let now = typeof start === 'number' ? start : start.getTime()
  let seq = 0
  const timers = new Set<Timer>()

  /** Fires every timer due by `until`, earliest first, moving the time to each; timers they start fire too if due. */
  async function runUntil(until: number) {
    await settle()
    for (;;) {
      const [next] = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.seq - b.seq)
      if (!next) break
      timers.delete(next)
      now = Math.max(now, next.at)
      await next.run()
      await settle()
    }
    now = Math.max(now, until)
  }

  const clock = {
    now: () => now,
    setTimer(run: () => void | Promise<void>, ms: number): ClockTimer {
      const timer: Timer = { at: now + Math.max(ms, 0), seq: seq++, run }
      timers.add(timer)
      return timer as unknown as ClockTimer
    },
    clearTimer(timer: ClockTimer) {
      timers.delete(timer as unknown as Timer)
    },
    /** Moves the time forward by `ms`, firing the timers that fall due; resolves once their callbacks have settled. */
    advance: (ms: number) => runUntil(now + ms),
    /** Moves the time forward to `date` (never back), as `advance` does. */
    advanceTo: (date: Date | number) => runUntil(typeof date === 'number' ? date : date.getTime()),
  } satisfies Clock & Record<string, unknown>
  return clock
}

export type FakeClock = ReturnType<typeof createFakeClock>
