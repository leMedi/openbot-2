import { type Db, settings } from '@openbot/db'
import { eq, inArray } from 'drizzle-orm'

/**
 * Model refs (`provider/modelId`). A null computer-use model is "same as each bot's model" (its own, else the default);
 * a null memory model, which memory extraction runs on, is "same as default"; a null default is not chosen yet.
 */
export type ModelSettings = {
  defaultModel: string | null
  computerUseModel: string | null
  memoryModel: string | null
}

const modelSettingKeys = ['defaultModel', 'computerUseModel', 'memoryModel'] as const satisfies (keyof ModelSettings)[]

export async function readModelSettings(db: Db): Promise<ModelSettings> {
  const rows = await db.select().from(settings).where(inArray(settings.key, modelSettingKeys))
  const stored = new Map(rows.map((row) => [row.key, row.value as string]))
  return {
    defaultModel: stored.get('defaultModel') ?? null,
    computerUseModel: stored.get('computerUseModel') ?? null,
    memoryModel: stored.get('memoryModel') ?? null,
  }
}

export async function writeModelSettings(db: Db, changes: Partial<ModelSettings>): Promise<ModelSettings> {
  await db.transaction(async (tx) => {
    for (const key of modelSettingKeys) {
      const value = changes[key]
      if (value === undefined) continue
      if (value === null) {
        await tx.delete(settings).where(eq(settings.key, key))
        continue
      }
      await tx
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    }
  })
  return readModelSettings(db)
}

/** A time zone the owner can't have: not an IANA one known to this server. */
export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`${timeZone} isn't a known IANA time zone, e.g. Europe/Paris`)
    this.name = 'InvalidTimeZoneError'
  }
}

/**
 * `timeZone` spelled as the server knows it (e.g. `utc` → `UTC`), or an `InvalidTimeZoneError` for anything but a
 * known IANA time zone. UTC offsets such as `+01:00` are refused: they don't follow daylight saving time.
 */
export function canonicalTimeZone(timeZone: string): string {
  if (/^[+-]/.test(timeZone)) throw new InvalidTimeZoneError(timeZone)
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    throw new InvalidTimeZoneError(timeZone)
  }
}

/** The owner's time zone after a write, and whether the write changed it. */
export type TimeZoneWrite = { timeZone: string; changed: boolean }

/** The owner's IANA time zone, or null until the web app detects it. */
export async function readTimeZone(db: Db): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'timeZone'))
  return (row?.value as string | undefined) ?? null
}

/** The time zone scheduled jobs follow: the owner's, or UTC until it is detected. */
export async function ownerTimeZone(db: Db): Promise<string> {
  return (await readTimeZone(db)) ?? 'UTC'
}

/**
 * Sets the owner's time zone, as they chose it in Settings → General; an `InvalidTimeZoneError` if it isn't a known
 * IANA one. Resolves with whether it changed.
 */
export async function writeTimeZone(db: Db, timeZone: string): Promise<TimeZoneWrite> {
  const value = canonicalTimeZone(timeZone)
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(settings).where(eq(settings.key, 'timeZone'))
    if (before?.value === value) return { timeZone: value, changed: false }
    await tx
      .insert(settings)
      .values({ key: 'timeZone', value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    return { timeZone: value, changed: true }
  })
}

/**
 * Keeps `timeZone`, a browser's, as the owner's only if none is set yet: once set, only the owner changes it. An
 * `InvalidTimeZoneError` if it isn't a known IANA one. Resolves with the owner's time zone and whether it was just set.
 */
export async function detectTimeZone(db: Db, timeZone: string): Promise<TimeZoneWrite> {
  const value = canonicalTimeZone(timeZone)
  const inserted = await db.insert(settings).values({ key: 'timeZone', value }).onConflictDoNothing().returning()
  if (inserted.length > 0) return { timeZone: value, changed: true }
  return { timeZone: (await readTimeZone(db))!, changed: false }
}

/**
 * The owner as they introduce themselves at onboarding and in Settings → General: the name bots call them by (null
 * until they give it) and a few words about them, empty when they gave none.
 */
export type OwnerProfile = { name: string | null; about: string }

const ownerProfileKeys = { name: 'ownerName', about: 'ownerAbout' } as const satisfies Record<keyof OwnerProfile, string>

export async function readOwnerProfile(db: Db): Promise<OwnerProfile> {
  const rows = await db.select().from(settings).where(inArray(settings.key, Object.values(ownerProfileKeys)))
  const stored = new Map(rows.map((row) => [row.key, row.value as string]))
  return { name: stored.get(ownerProfileKeys.name) ?? null, about: stored.get(ownerProfileKeys.about) ?? '' }
}

/** Changes the owner's profile; the fields left out stay. Bots see it on their next run. */
export async function writeOwnerProfile(db: Db, changes: Partial<{ name: string; about: string }>): Promise<OwnerProfile> {
  await db.transaction(async (tx) => {
    for (const field of ['name', 'about'] as const) {
      const value = changes[field]
      if (value === undefined) continue
      const key = ownerProfileKeys[field]
      await tx
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    }
  })
  return readOwnerProfile(db)
}
