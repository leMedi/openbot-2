import { useLiveEvents } from '@openbot/client'
import { useEffect, useState } from 'react'
import { useInstance } from './instance-context.ts'

/** The owner's time zone, which routines follow; undefined until known (times then read "in your time zone"). */
export function useOwnerTimeZone(): string | undefined {
  const { api } = useInstance()
  const [timeZone, setTimeZone] = useState<string>()
  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    let current = true
    api.general
      .getSettings()
      .then((settings) => current && setTimeZone(settings.timeZone ?? undefined))
      .catch(() => {})
    return () => void (current = false)
  }, [api, reloads])
  useLiveEvents((event) => {
    if (event.type === 'hello' && !event.resumed) setReloads((count) => count + 1)
    if (event.type === 'timeZone.updated') setTimeZone(event.timeZone ?? undefined)
  })
  return timeZone
}
