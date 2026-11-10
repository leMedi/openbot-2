import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

/**
 * Whether the app is in front of the owner, for the live stream, which closes in the background (iOS may reclaim its
 * socket while suspended, and Android gives no promise). iOS's `inactive` (Control Centre, a call, the app switcher)
 * still counts as in front, so a glance at Notification Centre doesn't drop the stream.
 */
export function useAppActive(): boolean {
  // Unknown (null) at the very start counts as in front, as the app is launching.
  const [state, setState] = useState(AppState.currentState)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setState)
    return () => subscription.remove()
  }, [])
  return state !== 'background'
}
