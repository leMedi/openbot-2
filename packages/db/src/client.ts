import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { paths } from './env.ts'
import * as schema from './schema.ts'

export function createDb(file = paths.database) {
  mkdirSync(paths.dataDir, { recursive: true })
  const client = createClient({ url: pathToFileURL(file).href })
  return drizzle(client, { schema })
}

export type Db = ReturnType<typeof createDb>
