import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import * as schema from './schema.ts'

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

/** Opens the libSQL file at `file`, creating it and applying pending migrations. */
export async function openDb(file: string) {
  mkdirSync(dirname(file), { recursive: true })
  const client = createClient({ url: pathToFileURL(file).href })
  // Bot deletion relies on real cascades (ADR 0009); SQLite leaves them off per connection.
  await client.execute('PRAGMA foreign_keys = ON')
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  return db
}

export type Db = Awaited<ReturnType<typeof openDb>>
