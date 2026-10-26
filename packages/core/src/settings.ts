import { type Db, settings } from '@openbot/db'
import { eq, inArray } from 'drizzle-orm'

/** Model refs (`provider/modelId`). A null computer-use model is "same as default"; a null default is not chosen yet. */
export type ModelSettings = {
  defaultModel: string | null
  computerUseModel: string | null
}

const modelSettingKeys = ['defaultModel', 'computerUseModel'] as const satisfies (keyof ModelSettings)[]

export async function readModelSettings(db: Db): Promise<ModelSettings> {
  const rows = await db.select().from(settings).where(inArray(settings.key, modelSettingKeys))
  const stored = new Map(rows.map((row) => [row.key, row.value as string]))
  return { defaultModel: stored.get('defaultModel') ?? null, computerUseModel: stored.get('computerUseModel') ?? null }
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
