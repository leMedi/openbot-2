import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppActive } from '../app-state.ts'
import type { CheckResult } from './check.ts'
import { checkFromPhone } from './phone.ts'

/**
 * Checks the instance at `url` again: at once, whenever the app comes back to the foreground, every `everyMs` while
 * in front if given, and when `check` is called (Check again). Each result goes to `onResult`; `checking` is true while
 * one runs, and `last` is the latest result.
 */
export function useRecheck(url: string, onResult: (result: CheckResult) => void, { everyMs }: { everyMs?: number } = {}) {
  const active = useAppActive()
  const [checking, setChecking] = useState(false)
  const [last, setLast] = useState<CheckResult>()
  const latest = useRef(onResult)
  useEffect(() => void (latest.current = onResult))
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])

  const check = useCallback(async () => {
    if (running.current) return
    running.current = true
    setChecking(true)
    try {
      const result = await checkFromPhone([url])
      if (!mounted.current) return
      setLast(result)
      latest.current(result)
    } finally {
      running.current = false
      if (mounted.current) setChecking(false)
    }
  }, [url])

  useEffect(() => {
    if (!active) return
    void check()
    if (!everyMs) return
    const timer = setInterval(() => void check(), everyMs)
    return () => clearInterval(timer)
  }, [active, check, everyMs])

  return { check, checking, last }
}
