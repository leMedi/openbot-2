import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void) {
  addEventListener('focus', onChange)
  addEventListener('blur', onChange)
  document.addEventListener('visibilitychange', onChange)
  return () => {
    removeEventListener('focus', onChange)
    removeEventListener('blur', onChange)
    document.removeEventListener('visibilitychange', onChange)
  }
}

const isFocused = () => document.visibilityState === 'visible' && document.hasFocus()

/** Whether this tab is in front of the owner: shown, and its window focused. */
export function useFocusedTab(): boolean {
  return useSyncExternalStore(subscribe, isFocused, () => false)
}
