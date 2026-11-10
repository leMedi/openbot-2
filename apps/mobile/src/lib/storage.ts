import type { KeyValueStorage } from '@openbot/client'
import { Storage } from 'expo-sqlite/kv-store'

/**
 * expo-sqlite's synchronous key–value store, kept in the app's documents: LiveStore's drafts, and the app's own keys
 * (`storage-keys.ts`).
 */
export const kvStorage: KeyValueStorage = {
  keys: () => Storage.getAllKeysSync(),
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => Storage.setItemSync(key, value),
  removeItem: (key) => void Storage.removeItemSync(key),
}
