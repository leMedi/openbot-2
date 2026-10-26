import type { LiveEvent } from '@openbot/api-contract'
import { EventBus } from '@openbot/core'
import { openDb } from '@openbot/db'
import { paths } from '@openbot/db/env'
import type { ServerContext } from './context.ts'

let context: Promise<ServerContext> | undefined

/** The server's one context, opened (and migrated) on the first request. */
export function getServerContext(): Promise<ServerContext> {
  context ??= openDb(paths.database).then(
    (db) => ({ db, bus: new EventBus<LiveEvent>() }),
    (error) => {
      context = undefined // let the next request retry
      throw error
    },
  )
  return context
}
