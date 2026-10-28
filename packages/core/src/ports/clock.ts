/** A timer a `Clock` started; only that clock can cancel it. */
export type ClockTimer = { readonly [timerBrand]: true }
declare const timerBrand: unique symbol

/**
 * The server's time: what scheduled server jobs wait on and what the timestamps it writes read. The system's in
 * production; tests move a fake one forward (`createFakeClock`).
 */
export type Clock = {
  /** Milliseconds since the epoch. */
  now(): number
  /**
   * Calls `run` once `ms` have passed; the timer never keeps the process alive. A fake clock waits for the promise
   * `run` returns before it moves on.
   */
  setTimer(run: () => void | Promise<void>, ms: number): ClockTimer
  /** Cancels `timer` unless it has fired. */
  clearTimer(timer: ClockTimer): void
}

/** Node caps a timer at about 24.8 days; a longer wait is made of several. */
const maxTimerMs = 2 ** 31 - 1

/** The system's time, with Node's timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(run, ms) {
    const timer: { handle?: ReturnType<typeof setTimeout> } = {}
    const until = Date.now() + ms
    const wait = (left: number) => {
      timer.handle = setTimeout(() => (left > maxTimerMs ? wait(until - Date.now()) : void run()), Math.min(Math.max(left, 0), maxTimerMs)).unref()
    }
    wait(ms)
    return timer as unknown as ClockTimer
  },
  clearTimer(timer) {
    clearTimeout((timer as unknown as { handle?: ReturnType<typeof setTimeout> }).handle)
  },
}
