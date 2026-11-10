import type { ChatInfo } from '@openbot/api-contract'
import { useEffect, useState } from 'react'

/** The current time, ticking each minute so relative times stay right, and at `wakeAt` (a mute ending) too. */
export function useNow(wakeAt?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (wakeAt === undefined) return
    // A timer can't wait longer than about 24.8 days; the minute tick catches anything later.
    const wait = wakeAt - Date.now()
    if (wait > 2 ** 31 - 1) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(wait, 0))
    return () => clearTimeout(timer)
  }, [wakeAt])
  return now
}

/** When the next of these chats' mutes ends, or undefined when none will. */
export function nextMuteEnd(chats: Iterable<ChatInfo>): number | undefined {
  const now = Date.now()
  let next: number | undefined
  for (const { mutedUntil } of chats) if (typeof mutedUntil === 'number' && mutedUntil > now && (next === undefined || mutedUntil < next)) next = mutedUntil
  return next
}
