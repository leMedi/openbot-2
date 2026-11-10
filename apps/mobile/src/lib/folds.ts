import { Storage } from 'expo-sqlite/kv-store'
import { useSyncExternalStore } from 'react'
import { foldsKey } from './storage-keys.ts'

function read(): Record<string, boolean> {
  try {
    return JSON.parse(Storage.getItemSync(foldsKey) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/** Which sections of the Chats list the owner folded (Hidden by `hiddenFoldKey`), kept on the phone. */
let folds: Readonly<Record<string, boolean>> = read()
const listeners = new Set<() => void>()

/** Folds or unfolds a section (Hidden by `hiddenFoldKey`), kept for the next start. */
export function setFolded(id: string, folded: boolean) {
  folds = { ...folds, [id]: folded }
  try {
    Storage.setItemSync(foldsKey, JSON.stringify(folds))
  } catch {
    // Not kept: the choice lasts while the app is open.
  }
  for (const listener of listeners) listener()
}

/** Reads the folds again from storage, e.g. once the phone forgot its instance's. */
export function reloadFolds() {
  folds = read()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** The folded sections, re-rendering when they change. */
export function useFolds(): Readonly<Record<string, boolean>> {
  return useSyncExternalStore(subscribe, () => folds)
}
