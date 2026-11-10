import { type Db, type Device, type DevicePlatform, devices } from '@openbot/db'
import { asc, eq } from 'drizzle-orm'

/** There is no registered phone with that id. */
export class DeviceNotFoundError extends Error {}

/** What a phone registers with: its Expo push token, its name and its platform. */
export type DeviceRegistration = { expoPushToken: string; name: string; platform: DevicePlatform }

/** A phone's notification switches: Messages, and When a bot needs you. */
export type DeviceSwitches = { notifyMessages?: boolean; notifyNeedsYou?: boolean }

/**
 * Registers a phone for push notifications. A token already registered keeps its row, and its switches, with the name
 * and platform updated. A phone the owner removed gets nothing until it registers again.
 */
export async function registerDevice(db: Db, { expoPushToken, name, platform }: DeviceRegistration): Promise<Device> {
  const [device] = await db
    .insert(devices)
    .values({ expoPushToken, name, platform })
    .onConflictDoUpdate({ target: devices.expoPushToken, set: { name, platform, updatedAt: new Date() } })
    .returning()
  return device!
}

/** The registered phones, oldest first. */
export async function listDevices(db: Db): Promise<Device[]> {
  return db.select().from(devices).orderBy(asc(devices.id))
}

/** Unregisters the phone with that token (the phone disconnecting); nothing happens when it isn't registered. */
export async function unregisterDevice(db: Db, expoPushToken: string): Promise<void> {
  await db.delete(devices).where(eq(devices.expoPushToken, expoPushToken))
}

/** Removes a registered phone (the owner, from Settings → General → Phones). */
export async function removeDevice(db: Db, id: string): Promise<void> {
  const [removed] = await db.delete(devices).where(eq(devices.id, id)).returning({ id: devices.id })
  if (!removed) throw new DeviceNotFoundError('No such phone')
}

/** Turns a phone's notification switches on or off; a switch left out keeps its value. */
export async function setDeviceSwitches(db: Db, id: string, switches: DeviceSwitches): Promise<Device> {
  // Bumping updatedAt keeps the update valid when no switch is given.
  const [device] = await db
    .update(devices)
    .set({ ...switches, updatedAt: new Date() })
    .where(eq(devices.id, id))
    .returning()
  if (!device) throw new DeviceNotFoundError('No such phone')
  return device
}
