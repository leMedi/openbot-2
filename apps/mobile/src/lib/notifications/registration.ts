import type { ApiClient, DeviceInfo } from '@openbot/api-contract'
import type { KeyValueStorage } from '@openbot/client'
import { errorMessage } from '../errors.ts'
import { notificationsKey, unregisterKey } from '../storage-keys.ts'

/** Whether the phone lets the app notify, and whether it may still ask the owner. */
export type Permission = { status: 'granted' | 'denied' | 'undetermined'; canAskAgain: boolean }

/** What the phone's OS gives: the permission to notify, asking for it, and the phone's push token. */
export type NotificationsOs = {
  permission(): Promise<Permission>
  requestPermission(): Promise<Permission>
  /** The phone's Expo push token; throws when this build of the app can't get one. */
  pushToken(): Promise<string>
  deviceName: string
  platform: DeviceInfo['platform']
}

/** The instance's `devices` endpoints the phone uses. */
export type DevicesApi = Pick<ApiClient['devices'], 'register' | 'unregister' | 'list' | 'setSwitches'>

export type NotificationsState = {
  /** Unknown until read. */
  permission?: Permission
  /** This phone's row on the instance while it's registered: on, with its switches. */
  device?: DeviceInfo
  /** Why the last change didn't happen. */
  error?: string
}

/**
 * What the phone keeps of its registration on the instance it's on (an instance key: Disconnect drops it); `retry`
 * while the first registration after asking couldn't be made (the instance unreachable), tried again at each refresh.
 */
type Saved = { asked?: true; retry?: true; device?: { id: string; token: string } }

/** Unregisterings Disconnect couldn't do, as the instance couldn't be reached; a phone key, tried at each launch. */
type Pending = { url: string; instanceId: string; token: string }[]

const notFound = (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND'

/**
 * This phone's notifications from the instance it's on (spec: Notifications on the phone). The first time Chats
 * appears after connecting, it asks for the permission (no pre-prompt) and, if allowed, registers the phone's push
 * token, name and platform. It doesn't register again at each launch: a phone the owner removed on the web stays off
 * until it's turned on in Settings → This phone → Notifications. A new push token moves the registration, keeping
 * its switches. Forgetting the instance unregisters it, again at later launches if it can't be reached then.
 */
export class PhoneNotifications {
  readonly #storage: KeyValueStorage
  readonly #devices: DevicesApi
  readonly #os: NotificationsOs
  readonly #instance: { url: string; instanceId: string }
  readonly #listeners = new Set<() => void>()
  #state: NotificationsState = {}

  constructor({
    storage,
    devices,
    os,
    instance,
  }: {
    storage: KeyValueStorage
    devices: DevicesApi
    os: NotificationsOs
    instance: { url: string; instanceId: string }
  }) {
    this.#storage = storage
    this.#devices = devices
    this.#os = os
    this.#instance = instance
  }

  get state(): NotificationsState {
    return this.#state
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  /** Chats appeared: the first time after connecting, asks and registers; later, checks the registration still holds. */
  async chatsShown() {
    const saved = this.#saved()
    if (saved.asked) return this.refresh()
    this.#save({ ...saved, asked: true })
    if ((await this.#ask()).status === 'granted' && !(await this.#register())) this.#save({ ...this.#saved(), retry: true })
  }

  /**
   * Reads the permission again (the owner may have changed it in the phone's settings) and the phone's row: gone means
   * the owner removed it on the web, so it's off; a new push token moves the registration.
   */
  async refresh() {
    this.#set({ permission: await this.#os.permission() })
    const { device: saved, retry } = this.#saved()
    if (!saved) {
      this.#set({ device: undefined })
      if (retry && this.#state.permission?.status === 'granted') await this.#register()
      return
    }
    let device: DeviceInfo | undefined
    try {
      device = (await this.#devices.list()).find((each) => each.id === saved.id)
    } catch {
      return // Can't tell while the instance can't be reached.
    }
    if (!device) return this.#forgetDevice()
    this.#set({ device })
    let token: string
    try {
      token = await this.#os.pushToken()
    } catch {
      return
    }
    if (token === saved.token) return
    await this.#register(token, device).catch(() => {})
  }

  /** Settings' Notifications switch on: asks if it still can, then registers; `denied` when the phone won't allow it. */
  async turnOn(): Promise<'on' | 'denied' | 'failed'> {
    if ((await this.#ask()).status !== 'granted') return 'denied'
    return (await this.#register()) ? 'on' : 'failed'
  }

  /** Settings' Notifications switch off: unregisters the phone. */
  async turnOff() {
    const saved = this.#saved().device
    if (!saved) return
    try {
      await this.#devices.unregister({ expoPushToken: saved.token })
      this.#forgetDevice()
    } catch (error) {
      this.#set({ error: errorMessage(error) })
    }
  }

  /** Turns Messages or When a bot needs you on or off for this phone. */
  async setSwitches(switches: { messages?: boolean; needsYou?: boolean }) {
    const device = this.#state.device
    if (!device) return
    this.#set({ device: { ...device, ...switches }, error: undefined })
    try {
      this.#set({ device: await this.#devices.setSwitches({ deviceId: device.id, ...switches }) })
    } catch (error) {
      if (notFound(error)) return this.#forgetDevice('This phone was removed in OpenBot on the web. Turn notifications on to add it again.')
      this.#set({ device, error: errorMessage(error) })
    }
  }

  /**
   * The phone leaves the instance (Disconnect, another instance): unregisters it, or, if the instance can't be reached,
   * keeps the token to unregister at a later launch. Take what's saved before the instance's keys are wiped.
   */
  async forget() {
    const saved = this.#saved().device
    this.#forgetDevice()
    if (!saved) return
    try {
      await this.#devices.unregister({ expoPushToken: saved.token })
    } catch {
      const { url, instanceId } = this.#instance
      writePending(this.#storage, [...readPending(this.#storage), { url, instanceId, token: saved.token }])
    }
  }

  /** Registers `token` (the phone's own when left out), carrying over `previous`'s switches; whether it worked. */
  async #register(token?: string, previous?: DeviceInfo): Promise<boolean> {
    try {
      const expoPushToken = token ?? (await this.#os.pushToken())
      let device = await this.#devices.register({ expoPushToken, name: this.#os.deviceName, platform: this.#os.platform })
      const old = this.#saved().device
      if (previous && (previous.messages !== device.messages || previous.needsYou !== device.needsYou)) {
        device = await this.#devices.setSwitches({ deviceId: device.id, messages: previous.messages, needsYou: previous.needsYou })
      }
      if (old && old.token !== expoPushToken) await this.#devices.unregister({ expoPushToken: old.token }).catch(() => {})
      const { retry: _retry, ...saved } = this.#saved()
      this.#save({ ...saved, device: { id: device.id, token: expoPushToken } })
      // Registered here again: an unregistering still to do for this instance would undo it.
      writePending(
        this.#storage,
        readPending(this.#storage).filter((each) => each.instanceId !== this.#instance.instanceId),
      )
      this.#set({ device, error: undefined })
      return true
    } catch (error) {
      this.#set({ error: errorMessage(error) })
      return false
    }
  }

  /** The permission, asked for when the phone may still ask. */
  async #ask(): Promise<Permission> {
    let permission = await this.#os.permission()
    if (permission.status === 'undetermined' && permission.canAskAgain) permission = await this.#os.requestPermission()
    this.#set({ permission })
    return permission
  }

  #forgetDevice(error?: string) {
    const { device: _device, retry: _retry, ...rest } = this.#saved()
    this.#save(rest)
    this.#set({ device: undefined, error })
  }

  #saved(): Saved {
    try {
      return JSON.parse(this.#storage.getItem(notificationsKey) ?? '{}') as Saved
    } catch {
      return {}
    }
  }

  #save(saved: Saved) {
    this.#storage.setItem(notificationsKey, JSON.stringify(saved))
  }

  #set(changes: Partial<NotificationsState>) {
    this.#state = { ...this.#state, ...changes }
    for (const listener of this.#listeners) listener()
  }
}

function readPending(storage: KeyValueStorage): Pending {
  try {
    return JSON.parse(storage.getItem(unregisterKey) ?? '[]') as Pending
  } catch {
    return []
  }
}

function writePending(storage: KeyValueStorage, pending: Pending) {
  if (pending.length) storage.setItem(unregisterKey, JSON.stringify(pending))
  else storage.removeItem(unregisterKey)
}

/** Unregisters the phone from instances it left while they couldn't be reached; those still unreachable wait. */
export async function retryUnregistering(storage: KeyValueStorage, devicesAt: (url: string) => Pick<DevicesApi, 'unregister'>) {
  const pending = readPending(storage)
  if (!pending.length) return
  const left: Pending = []
  for (const entry of pending) {
    try {
      await devicesAt(entry.url).unregister({ expoPushToken: entry.token })
    } catch {
      left.push(entry)
    }
  }
  // Re-read: a registration meanwhile may have dropped some.
  const now = readPending(storage)
  writePending(
    storage,
    now.filter((entry) => left.some((each) => each.instanceId === entry.instanceId && each.token === entry.token)),
  )
}
