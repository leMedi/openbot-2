import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrationsFolder, openMigrated } from './client.ts'

/**
 * Creates the libSQL file at `file` as it was just before migration `tag` (e.g. `0008_memory_shared_write`), so a test
 * can store data the old way and see `openDb` migrate it. Write to it with raw SQL: the schema is today's.
 */
export async function openDbBefore(file: string, tag: string) {
  const folder = await mkdtemp(join(tmpdir(), 'openbot-migrations-'))
  try {
    await cp(migrationsFolder, folder, { recursive: true })
    const journalFile = join(folder, 'meta', '_journal.json')
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { entries: { tag: string }[] }
    const index = journal.entries.findIndex((entry) => entry.tag === tag)
    if (index === -1) throw new Error(`No migration ${tag}`)
    await writeFile(journalFile, JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }))
    return await openMigrated(file, folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
