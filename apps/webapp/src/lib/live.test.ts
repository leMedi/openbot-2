import { describe, expect, it } from 'vitest'
import { LiveStore } from './live.tsx'

/** The browser's localStorage, in memory. */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
  }
}

/** Storage as in a private window or with site data blocked: every access throws. */
function blockedStorage(): Storage {
  const blocked = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  return {
    get length() {
      return blocked()
    },
    key: blocked,
    getItem: blocked,
    setItem: blocked,
    removeItem: blocked,
    clear: blocked,
  }
}

describe('drafts', () => {
  it('survive a reload', () => {
    const storage = memoryStorage()
    new LiveStore(storage).setDraft('chat-1', 'half a thought')

    expect(new LiveStore(storage).drafts.get('chat-1')).toBe('half a thought')
  })

  it('are gone after a reload once sent', () => {
    const storage = memoryStorage()
    const store = new LiveStore(storage)
    store.setDraft('chat-1', 'half a thought')
    store.setDraft('chat-1', '')

    expect(new LiveStore(storage).drafts.has('chat-1')).toBe(false)
  })

  it('of a deleted chat are gone after a reload', () => {
    const storage = memoryStorage()
    const store = new LiveStore(storage)
    store.setDraft('group-1', 'to the group')
    store.setDraft('dm-1', 'to the bot')
    store.removeChat('group-1')
    store.removeBot('bot-1', 'dm-1')

    expect(new LiveStore(storage).drafts.size).toBe(0)
  })

  it('are kept in memory when storage is blocked', () => {
    const store = new LiveStore(blockedStorage())
    store.setDraft('chat-1', 'half a thought')
    expect(store.drafts.get('chat-1')).toBe('half a thought')

    store.setDraft('chat-1', '')
    store.removeChat('chat-1')
    expect(store.drafts.has('chat-1')).toBe(false)
  })
})
