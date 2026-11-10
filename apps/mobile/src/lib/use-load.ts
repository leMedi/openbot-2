import { useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { errorMessage } from './errors.ts'

export type Loaded<T> = {
  /** What was loaded, undefined until it first is. */
  data: T | undefined
  /** Why the last load failed, cleared by the next one that works. */
  error: string | undefined
  /** Replaces what was loaded, e.g. with what a change returned. */
  setData: (data: T) => void
  reload: () => void
}

/**
 * Loads `load` each time the screen comes into focus, as a pushed screen may have changed what it shows (a model
 * chosen), and each time the app comes back to the foreground on it (a plugin connected in the browser); a load
 * finishing after a later one started is dropped. `load` should be stable (useCallback).
 */
export function useLoadOnFocus<T>(load: () => Promise<T>): Loaded<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const latest = useRef(0)
  const reload = useCallback(() => {
    const mine = ++latest.current
    load().then(
      (next) => {
        if (mine !== latest.current) return
        setData(next)
        setError(undefined)
      },
      (caught) => mine === latest.current && setError(errorMessage(caught)),
    )
  }, [load])
  useFocusEffect(
    useCallback(() => {
      reload()
      // Back from the browser (a plugin signed in on the web), or from changes made elsewhere meanwhile.
      const subscription = AppState.addEventListener('change', (state) => state === 'active' && reload())
      const loads = latest
      return () => {
        subscription.remove()
        // Leaving drops a load still on its way.
        loads.current++
      }
    }, [reload]),
  )
  const replace = useCallback((next: T) => {
    latest.current++
    setData(next)
  }, [])
  return { data, error, setData: replace, reload }
}
