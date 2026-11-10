import type { KeyValueStorage, LiveSnapshot, SnapshotStore } from '@openbot/client'
import type { SavedInstance } from './saved-instance.ts'
import { instanceKey, snapshotKey } from './storage-keys.ts'

/** The snapshot as kept on the phone, with the instance it was taken of. */
type Kept = { instanceId: string; snapshot: LiveSnapshot }

/** The instance this phone is on now, as `saved-instance.ts` keeps it in `storage`; none if it can't be read. */
function currentInstanceId(storage: KeyValueStorage): string | undefined {
  try {
    const saved = storage.getItem(instanceKey)
    return saved ? (JSON.parse(saved) as SavedInstance).instanceId : undefined
  } catch {
    return undefined
  }
}

/**
 * Where the live store keeps the instance's chats and loaded messages on this phone (spec: Offline), in `storage`
 * with the instance they came from, to show while it can't be reached. Only a snapshot of `instanceId` is restored,
 * and it is saved only while the phone is still on that instance, so a save due after the phone left it (Disconnect,
 * another instance) never brings back what was forgotten.
 */
export function phoneSnapshot(storage: KeyValueStorage, instanceId: string): SnapshotStore {
  return {
    load() {
      try {
        const raw = storage.getItem(snapshotKey)
        if (!raw) return undefined
        const kept = JSON.parse(raw) as Kept
        return kept.instanceId === instanceId ? kept.snapshot : undefined
      } catch {
        return undefined
      }
    },
    save(snapshot) {
      if (currentInstanceId(storage) !== instanceId) return
      storage.setItem(snapshotKey, JSON.stringify({ instanceId, snapshot } satisfies Kept))
    },
  }
}
