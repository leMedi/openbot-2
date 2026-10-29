import { useEffect, useRef } from 'react'
import type { PaletteTab } from './palette.ts'

/** What one part of the app asks another to do: the palette opening, or the sidebar starting a new bot or section. */
export type Commands = {
  /** Opens the command palette, on a tab. */
  'open-palette': PaletteTab
  'new-bot': undefined
  'new-section': undefined
}

type Listener<K extends keyof Commands> = (payload: Commands[K]) => void

const listeners = new Map<keyof Commands, Set<Listener<never>>>()

/** Asks whoever handles `command` to run it. */
export function runCommand<K extends keyof Commands>(command: K, ...[payload]: Commands[K] extends undefined ? [] : [Commands[K]]) {
  for (const listener of listeners.get(command) ?? []) (listener as Listener<K>)(payload as Commands[K])
}

/** Handles `command` with the latest `listener` while the component is mounted. */
export function useCommand<K extends keyof Commands>(command: K, listener: Listener<K>) {
  const latest = useRef(listener)
  latest.current = listener
  useEffect(() => {
    const handle: Listener<K> = (payload) => latest.current(payload)
    const set = listeners.get(command) ?? new Set()
    set.add(handle as Listener<never>)
    listeners.set(command, set)
    return () => void set.delete(handle as Listener<never>)
  }, [command])
}
