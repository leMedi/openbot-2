import { Storage } from 'expo-sqlite/kv-store'
import { useState } from 'react'
import { instanceKey, localNetworkAskedKey } from './storage-keys.ts'

/** The instance this phone connects to, kept once Connect reached it. */
export type SavedInstance = {
  /** The origin that answered, e.g. `http://192.168.1.20:3000`; the app adds `/api`. */
  url: string
  instanceId: string
  /** Its onboarding was done. Until then the app shows Finish setup; after, it never goes back to Connect. */
  setUp: boolean
}


function load(): SavedInstance | undefined {
  try {
    const saved = Storage.getItemSync(instanceKey)
    return saved ? (JSON.parse(saved) as SavedInstance) : undefined
  } catch {
    return undefined
  }
}

/** The saved instance and a setter that keeps it, `undefined` to forget it. */
export function useSavedInstance(): [SavedInstance | undefined, (instance: SavedInstance | undefined) => void] {
  const [instance, setInstance] = useState(load)
  const save = (next: SavedInstance | undefined) => {
    if (next) Storage.setItemSync(instanceKey, JSON.stringify(next))
    else Storage.removeItemSync(instanceKey)
    setInstance(next)
  }
  return [instance, save]
}

export const localNetworkAsked = {
  get: () => Storage.getItemSync(localNetworkAskedKey) === 'yes',
  set: () => Storage.setItemSync(localNetworkAskedKey, 'yes'),
}
