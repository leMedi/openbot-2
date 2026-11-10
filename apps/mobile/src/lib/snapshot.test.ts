import type { KeyValueStorage, LiveSnapshot } from '@openbot/client'
import { describe, expect, it } from 'vitest'
import { forgetInstanceData } from './forget.ts'
import { phoneSnapshot } from './snapshot.ts'

function fakeStorage(entries: Record<string, string> = {}): KeyValueStorage & { entries: Map<string, string> } {
  const map = new Map(Object.entries(entries))
  return {
    entries: map,
    keys: () => [...map.keys()],
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const instance = (instanceId: string) => JSON.stringify({ url: 'http://192.168.1.20:3000', instanceId, setUp: true })

const snapshot = { version: 2, bots: [], chats: [], sections: [], messages: [] } as unknown as LiveSnapshot

describe("the phone's snapshot", () => {
  it('is kept for the next start of the app on the same instance', () => {
    const storage = fakeStorage({ 'openbot.instance': instance('home') })
    phoneSnapshot(storage, 'home').save(snapshot)
    expect(phoneSnapshot(storage, 'home').load()).toEqual(snapshot)
  })

  it("of another instance isn't shown", () => {
    const storage = fakeStorage({ 'openbot.instance': instance('home') })
    phoneSnapshot(storage, 'home').save(snapshot)
    expect(phoneSnapshot(storage, 'office').load()).toBeUndefined()
  })

  it("isn't saved once the phone left the instance, by a save due after it forgot it", () => {
    const storage = fakeStorage({ 'openbot.instance': instance('home') })
    const store = phoneSnapshot(storage, 'home')
    forgetInstanceData(storage)
    store.save(snapshot)
    expect(storage.entries.size).toBe(0)

    storage.setItem('openbot.instance', instance('office'))
    store.save(snapshot)
    expect(phoneSnapshot(storage, 'office').load()).toBeUndefined()
  })

  it('is forgotten with the instance', () => {
    const storage = fakeStorage({ 'openbot.instance': instance('home') })
    phoneSnapshot(storage, 'home').save(snapshot)
    forgetInstanceData(storage)
    storage.setItem('openbot.instance', instance('home'))
    expect(phoneSnapshot(storage, 'home').load()).toBeUndefined()
  })

  it("that can't be read is ignored", () => {
    const storage = fakeStorage({ 'openbot.instance': instance('home'), 'openbot.snapshot': '{"instanceId":"ho' })
    expect(phoneSnapshot(storage, 'home').load()).toBeUndefined()
  })
})
