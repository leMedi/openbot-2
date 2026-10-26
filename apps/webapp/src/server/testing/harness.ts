import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeModel } from '@openbot/agent/testing'
import { createFakeComputer } from '@openbot/core/testing'
import { openDb } from '@openbot/db'
import { createRouterClient } from '@orpc/server'
import { createServerContext } from '../context.ts'
import { handleApiRequest } from '../http.ts'
import { router } from '../router.ts'

/**
 * Seam 1: the router called in-process over a temporary database, with a scripted model and an in-memory computer.
 * Pass the `dataDir` of a closed server to simulate a restart on the same data.
 */
export async function createTestServer({ dataDir }: { dataDir?: string } = {}) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'openbot-test-')))
  const db = await openDb(join(dir, 'openbot.db'))
  const context = createServerContext(db)

  return {
    dataDir: dir,
    db,
    client: createRouterClient(router, { context }),
    model: createFakeModel(),
    computer: createFakeComputer(),
    /** An HTTP request against the API, e.g. `fetch('/api/health')`. */
    fetch: (path: string, init?: RequestInit) => handleApiRequest(new Request(new URL(path, 'http://openbot.test'), init), context),
    /** Closes the database; deletes the data unless it was passed in. */
    async close() {
      db.$client.close()
      if (!dataDir) await rm(dir, { recursive: true, force: true })
    },
  }
}

export type TestServer = Awaited<ReturnType<typeof createTestServer>>
