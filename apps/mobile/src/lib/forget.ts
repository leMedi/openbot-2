import type { KeyValueStorage } from '@openbot/client'
import { phoneKeys } from './storage-keys.ts'

/**
 * Removes what this phone keeps of its instance from `storage`: the instance itself, its snapshot, drafts and folded
 * sections; what belongs to the phone stays. A key that can't be removed is left, so the rest still goes.
 */
export function forgetInstanceData(storage: KeyValueStorage) {
  for (const key of storage.keys()) {
    if (phoneKeys.includes(key)) continue
    try {
      storage.removeItem(key)
    } catch {
      // Left behind; the others still go.
    }
  }
}
