import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { defineConfig } from 'drizzle-kit'
import { paths } from './src/env.ts'

mkdirSync(paths.dataDir, { recursive: true })

export default defineConfig({
  dialect: 'turso',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: pathToFileURL(paths.database).href },
})
