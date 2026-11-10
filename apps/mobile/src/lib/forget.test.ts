import type { KeyValueStorage } from '@openbot/client'
import { describe, expect, it } from 'vitest'
import { forgetInstanceData } from './forget.ts'

function fakeStorage(entries: Record<string, string>): KeyValueStorage & { entries: Map<string, string> } {
  const map = new Map(Object.entries(entries))
  return {
    entries: map,
    keys: () => [...map.keys()],
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

describe("forgetting an instance's data on this phone", () => {
  it('removes the instance, drafts and folded sections, keeping what belongs to the phone', () => {
    const storage = fakeStorage({
      'openbot.instance': '{"url":"http://192.168.1.20:3000","instanceId":"home","setUp":true}',
      'openbot.draft.chat-1': 'Half a thought',
      'openbot.draft.chat-2': 'Another',
      'openbot.chats.folds': '{"research":true}',
      'openbot.localNetworkAsked': 'yes',
      'openbot.dictation.download': '{"cellular":false}',
    })
    forgetInstanceData(storage)
    expect([...storage.entries]).toEqual([
      ['openbot.localNetworkAsked', 'yes'],
      ['openbot.dictation.download', '{"cellular":false}'],
    ])
  })

  it('removes what it can when storage fails on a key', () => {
    const storage = fakeStorage({ 'openbot.draft.a': 'x', 'openbot.draft.b': 'y' })
    const remove = storage.removeItem
    storage.removeItem = (key) => {
      if (key === 'openbot.draft.a') throw new Error('disk I/O error')
      remove(key)
    }
    forgetInstanceData(storage)
    expect([...storage.entries.keys()]).toEqual(['openbot.draft.a'])
  })
})
