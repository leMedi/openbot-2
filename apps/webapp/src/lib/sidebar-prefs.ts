import { useEffect, useState, useSyncExternalStore } from 'react'
import { hiddenFoldKey } from './sidebar.ts'

const foldsKey = 'openbot.sidebar.folds'
const compactKey = 'openbot.sidebar.compact'

/** Below this viewport width the sidebar is always the compact rail, as in Grok. */
const compactBelowPx = 760

function read<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key)
    return saved === null ? fallback : (JSON.parse(saved) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked or full: the choice lasts until reload.
  }
}

/**
 * How the owner left the sidebar in this browser: which sections are folded (Hidden by `hiddenFoldKey`) and whether
 * it is the compact rail. Shared by the sidebar, the palette and the shortcuts.
 */
class SidebarPrefs {
  folds: Readonly<Record<string, boolean>> = read(foldsKey, {})
  compact: boolean = read(compactKey, false)
  #version = 0
  #listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getVersion = () => this.#version

  setFolded(id: string, folded: boolean) {
    this.folds = { ...this.folds, [id]: folded }
    write(foldsKey, this.folds)
    this.#changed()
  }

  setCompact(compact: boolean) {
    this.compact = compact
    write(compactKey, compact)
    this.#changed()
  }

  /** Unfolds Hidden and leaves the rail, so the hidden chats show. */
  showHidden() {
    this.setFolded(hiddenFoldKey, false)
    if (this.compact) this.setCompact(false)
  }

  #changed() {
    this.#version++
    for (const listener of this.#listeners) listener()
  }
}

export const sidebarPrefs = new SidebarPrefs()

/** The sidebar's preferences, re-rendering when they change. */
export function useSidebarPrefs(): SidebarPrefs {
  useSyncExternalStore(sidebarPrefs.subscribe, sidebarPrefs.getVersion, sidebarPrefs.getVersion)
  return sidebarPrefs
}

/** Whether the window is too narrow for the full sidebar. */
export function useNarrowWindow(): boolean {
  const query = `(max-width: ${compactBelowPx - 1}px)`
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return narrow
}
