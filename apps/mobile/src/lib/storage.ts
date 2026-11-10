import type { KeyValueStorage } from '@openbot/client'
import { Storage } from 'expo-sqlite/kv-store'

/** Drafts' storage: expo-sqlite's synchronous key–value store, kept in the app's documents. */
export const draftStorage: KeyValueStorage = {
  keys: () => Storage.getAllKeysSync(),
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => Storage.setItemSync(key, value),
  removeItem: (key) => void Storage.removeItemSync(key),
}
