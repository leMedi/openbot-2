import { type KeyValueStorage, LiveProvider, LiveStore } from '@openbot/client'
import { type ReactNode, useState } from 'react'
import { api } from './api.ts'

/** This browser's localStorage; where it's missing or blocked every call throws (reading the global can too), and drafts last while the tab is open. */
const browserStorage: KeyValueStorage = {
  keys: () => {
    const storage = globalThis.localStorage
    return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key) => key !== null)
  },
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  removeItem: (key) => globalThis.localStorage.removeItem(key),
}

/** The live store for this origin, drafts in this browser's storage; browser only. The web keeps no snapshot. */
export function WebLiveProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new LiveStore({ api: api(), storage: browserStorage }))
  return <LiveProvider store={store}>{children}</LiveProvider>
}
