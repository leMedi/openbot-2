import type { DeviceInfo, DeviceRegistration } from '@openbot/api-contract'
import type { KeyValueStorage } from '@openbot/client'
import { describe, expect, it } from 'vitest'
import { type DevicesApi, type NotificationsOs, type Permission, PhoneNotifications, retryUnregistering } from './registration.ts'

function fakeStorage(): KeyValueStorage & { entries: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    entries: map,
    keys: () => [...map.keys()],
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

/** An instance's devices endpoints, as #103 has them, over rows in memory; `reachable` false fails every call. */
function fakeInstance() {
  const rows: (DeviceInfo & { token: string })[] = []
  let ids = 0
  const instance = {
    rows,
    reachable: true,
    calls: [] as string[],
    api: {
      register: async ({ expoPushToken, name, platform }: DeviceRegistration) => {
        instance.check('register')
        let row = rows.find((each) => each.token === expoPushToken)
        if (row) Object.assign(row, { name, platform })
        else rows.push((row = { id: `d${++ids}`, token: expoPushToken, name, platform, messages: true, needsYou: true, createdAt: 0 }))
        return view(row)
      },
      unregister: async ({ expoPushToken }: { expoPushToken: string }) => {
        instance.check('unregister')
        const index = rows.findIndex((each) => each.token === expoPushToken)
        if (index >= 0) rows.splice(index, 1)
      },
      list: async () => {
        instance.check('list')
        return rows.map(view)
      },
      setSwitches: async ({ deviceId, messages, needsYou }: { deviceId: string; messages?: boolean; needsYou?: boolean }) => {
        instance.check('setSwitches')
        const row = rows.find((each) => each.id === deviceId)
        if (!row) throw Object.assign(new Error('No such phone'), { code: 'NOT_FOUND' })
        if (messages !== undefined) row.messages = messages
        if (needsYou !== undefined) row.needsYou = needsYou
        return view(row)
      },
    } satisfies DevicesApi,
    check(call: string) {
      instance.calls.push(call)
      if (!instance.reachable) throw new TypeError('Network request failed')
    },
    /** The owner removing the phone on the web (Settings → General → Phones). */
    removeOnWeb(id: string) {
      rows.splice(
        rows.findIndex((each) => each.id === id),
        1,
      )
    },
  }
  return instance
}
const view = ({ token: _token, ...device }: DeviceInfo & { token: string }): DeviceInfo => ({ ...device })

/** The phone's notification permission and push token; the OS asks the owner and they answer `answer`. */
function fakeOs(answer: 'granted' | 'denied' = 'granted', token: string | Error = 'ExponentPushToken[phone-1]') {
  const state: { permission: Permission; asked: number; token: string | Error } = { permission: { status: 'undetermined', canAskAgain: true }, asked: 0, token }
  const os: NotificationsOs = {
    permission: async () => state.permission,
    requestPermission: async () => {
      state.asked++
      state.permission = { status: answer, canAskAgain: false }
      return state.permission
    },
    pushToken: async () => {
      if (state.token instanceof Error) throw state.token
      return state.token
    },
    deviceName: 'Mehdi’s Pixel',
    platform: 'android',
  }
  return Object.assign(state, { os })
}

function phone({ storage = fakeStorage(), instance = fakeInstance(), os = fakeOs() } = {}) {
  const notifications = new PhoneNotifications({ storage, devices: instance.api, os: os.os, instance: { url: 'http://192.168.1.20:3000', instanceId: 'home' } })
  return { notifications, storage, instance, os }
}

describe("the phone's notifications", () => {
  it('asks once, the first time Chats appears, and registers the phone when allowed', async () => {
    const { notifications, instance, os } = phone()
    await notifications.chatsShown()
    expect(os.asked).toBe(1)
    expect(instance.rows).toMatchObject([{ token: 'ExponentPushToken[phone-1]', name: 'Mehdi’s Pixel', platform: 'android' }])
    expect(notifications.state).toMatchObject({ permission: { status: 'granted' }, device: { id: 'd1', messages: true, needsYou: true } })

    await notifications.chatsShown()
    expect(os.asked).toBe(1)
    expect(instance.rows).toHaveLength(1)
  })

  it("registers nothing when the owner doesn't allow it, and says so when they turn it on", async () => {
    const { notifications, instance, os } = phone({ os: fakeOs('denied') })
    await notifications.chatsShown()
    expect(instance.rows).toEqual([])
    expect(await notifications.turnOn()).toBe('denied')
    expect(os.asked).toBe(1)
    expect(instance.rows).toEqual([])
    expect(notifications.state.device).toBeUndefined()
  })

  it('remembers its registration across launches, and a phone removed on the web stays off until turned on', async () => {
    const storage = fakeStorage()
    const instance = fakeInstance()
    await phone({ storage, instance }).notifications.chatsShown()

    // Launched again: still registered, without asking or registering anew.
    const again = phone({ storage, instance, os: Object.assign(fakeOs(), { permission: { status: 'granted', canAskAgain: false } as Permission }) })
    await again.notifications.chatsShown()
    expect(instance.calls.filter((call) => call === 'register')).toHaveLength(1)
    expect(again.notifications.state.device?.id).toBe('d1')

    instance.removeOnWeb('d1')
    const removed = phone({ storage, instance, os: Object.assign(fakeOs(), { permission: { status: 'granted', canAskAgain: false } as Permission }) })
    await removed.notifications.chatsShown()
    expect(instance.rows).toEqual([])
    expect(removed.notifications.state.device).toBeUndefined()

    expect(await removed.notifications.turnOn()).toBe('on')
    expect(instance.rows).toHaveLength(1)
  })

  it("turns a removed phone off when a switch can't find it", async () => {
    const { notifications, instance } = phone()
    await notifications.chatsShown()
    await notifications.setSwitches({ messages: false })
    expect(instance.rows[0]).toMatchObject({ messages: false, needsYou: true })
    expect(notifications.state.device).toMatchObject({ messages: false })

    instance.removeOnWeb('d1')
    await notifications.setSwitches({ needsYou: false })
    expect(notifications.state.device).toBeUndefined()
    expect(notifications.state.error).toMatch(/removed/)
  })

  it('moves to a new push token, keeping its switches', async () => {
    const storage = fakeStorage()
    const instance = fakeInstance()
    const first = phone({ storage, instance })
    await first.notifications.chatsShown()
    await first.notifications.setSwitches({ needsYou: false })

    const os = Object.assign(fakeOs(), { permission: { status: 'granted', canAskAgain: false } as Permission, token: 'ExponentPushToken[phone-2]' })
    const next = phone({ storage, instance, os })
    await next.notifications.chatsShown()
    expect(instance.rows).toMatchObject([{ token: 'ExponentPushToken[phone-2]', messages: true, needsYou: false }])
  })

  it('turns off by unregistering, and on again', async () => {
    const { notifications, instance } = phone()
    await notifications.chatsShown()
    await notifications.turnOff()
    expect(instance.rows).toEqual([])
    expect(notifications.state.device).toBeUndefined()
    expect(await notifications.turnOn()).toBe('on')
    expect(instance.rows).toHaveLength(1)
  })

  it("registers at a later launch when the instance couldn't be reached the first time", async () => {
    const storage = fakeStorage()
    const instance = fakeInstance()
    instance.reachable = false
    await phone({ storage, instance }).notifications.chatsShown()
    expect(instance.rows).toEqual([])

    instance.reachable = true
    const again = phone({ storage, instance, os: Object.assign(fakeOs(), { permission: { status: 'granted', canAskAgain: false } as Permission }) })
    await again.notifications.chatsShown()
    expect(instance.rows).toHaveLength(1)
    expect(again.notifications.state.device?.id).toBe('d1')
  })

  it("says so when this build can't get a push token", async () => {
    const { notifications, instance } = phone({ os: fakeOs('granted', new Error('No EAS project ID')) })
    await notifications.chatsShown()
    expect(instance.rows).toEqual([])
    expect(await notifications.turnOn()).toBe('failed')
    expect(notifications.state.error).toBe('No EAS project ID')
  })
})

describe('forgetting the instance (Disconnect, another instance)', () => {
  it('unregisters the phone', async () => {
    const { notifications, instance } = phone()
    await notifications.chatsShown()
    await notifications.forget()
    expect(instance.rows).toEqual([])
  })

  it("keeps trying to unregister while the instance can't be reached, until it registers there again", async () => {
    const storage = fakeStorage()
    const instance = fakeInstance()
    const { notifications } = phone({ storage, instance })
    await notifications.chatsShown()
    instance.reachable = false
    await notifications.forget()
    expect(instance.rows).toHaveLength(1)

    // Next launch, still unreachable: kept for later.
    await retryUnregistering(storage, () => instance.api)
    expect(instance.rows).toHaveLength(1)
    instance.reachable = true
    await retryUnregistering(storage, () => instance.api)
    expect(instance.rows).toEqual([])
    instance.calls.length = 0
    await retryUnregistering(storage, () => instance.api)
    expect(instance.calls).toEqual([])

    // Unreachable again; then the phone connects to it once more and registers: the old unregistering is dropped.
    await phone({ storage, instance }).notifications.chatsShown()
    instance.reachable = false
    const leaving = phone({ storage, instance, os: Object.assign(fakeOs(), { permission: { status: 'granted', canAskAgain: false } as Permission }) })
    await leaving.notifications.chatsShown()
    await leaving.notifications.forget()
    instance.reachable = true
    for (const key of [...storage.entries.keys()]) if (key !== 'openbot.notifications.unregister') storage.removeItem(key)
    const back = phone({ storage, instance })
    await back.notifications.chatsShown()
    await retryUnregistering(storage, () => instance.api)
    expect(instance.rows).toHaveLength(1)
  })
})
