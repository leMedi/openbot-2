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
  /** Changes what was loaded from what it is now, e.g. by a live event; nothing while it's still loading. */
  update: (change: (data: T) => T) => void
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
    // A load that throws at once fails like one that rejects.
    Promise.resolve().then(load).then(
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
  // Not dropping a load on its way, unlike setData: live events arrive all the time, and the load brings what they did.
  const update = useCallback((change: (data: T) => T) => {
    setData((current) => (current === undefined ? current : change(current)))
  }, [])
  return { data, error, setData: replace, update, reload }
}
