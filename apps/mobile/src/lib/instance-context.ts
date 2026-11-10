import type { ApiClient } from '@openbot/api-contract'
import { createContext, useContext } from 'react'
import type { CheckResult } from './connect/check.ts'
import type { PhoneNotifications } from './notifications/registration.ts'
import type { SavedInstance } from './saved-instance.ts'

/** The instance the app is on, for screens that reach it outside the live store. */
export type InstanceInfo = {
  url: string
  instanceId: string
  /** Its API, as the live store reaches it. */
  api: ApiClient
  /** Hands over a check of the instance made elsewhere (the banner's diagnosis), which may find a version block. */
  noteCheck: (result: CheckResult) => void
  /**
   * Moves the app to `instance` (Settings → Instance → Edit address): `forget` drops what this phone keeps of the
   * current one first, for another instance; the same instance at a new address keeps it.
   */
  moveTo: (instance: SavedInstance, options: { forget: boolean }) => void
  /** Leaves the instance (Settings → Instance → Disconnect): forgets what this phone keeps of it, back to Connect. */
  disconnect: () => void
  /** This phone's notifications from it. */
  notifications: PhoneNotifications
}

export const InstanceContext = createContext<InstanceInfo | undefined>(undefined)

export function useInstance(): InstanceInfo {
  const instance = useContext(InstanceContext)
  if (!instance) throw new Error('useInstance needs an instance')
  return instance
}
