import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import * as schema from './schema.ts'

/**
 * The package's migrations. Found through the package itself rather than relative to this file, which the web app's
 * server build bundles elsewhere.
 */
export const migrationsFolder = join(
  dirname(createRequire(import.meta.url).resolve('@openbot/db/package.json')),
  'drizzle',
)

/** Opens the libSQL file at `file`, creating it and applying pending migrations. */
export async function openDb(file: string) {
  return openMigrated(file, migrationsFolder)
}

/** Opens the libSQL file at `file`, creating it and applying the pending migrations in `folder`. */
export async function openMigrated(file: string, folder: string) {
  mkdirSync(dirname(file), { recursive: true })
  const client = createClient({ url: pathToFileURL(file).href })
  // Bot deletion relies on real cascades (ADR 0009); SQLite leaves them off per connection.
  await client.execute('PRAGMA foreign_keys = ON')
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: folder })
  return db
}

export type Db = Awaited<ReturnType<typeof openDb>>
