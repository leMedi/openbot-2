/** The longest dictation: at 2 minutes it stops and transcribes by itself. */
export const maxDictationMs = 120_000
/** The countdown shows over the last 10 seconds. */
const countdownMs = 10_000

/**
 * What the Listening… bar shows `elapsedMs` into a dictation: the time spoken (m:ss), the seconds left over the last 10,
 * and whether the 2 minutes are up.
 */
export function listeningClock(elapsedMs: number): { time: string; secondsLeft: number | undefined; over: boolean } {
  const shown = Math.min(Math.max(0, elapsedMs), maxDictationMs)
  const seconds = Math.floor(shown / 1000)
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const left = maxDictationMs - shown
  return { time, secondsLeft: left <= countdownMs ? Math.ceil(left / 1000) : undefined, over: left <= 0 }
}
