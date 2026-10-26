import type { LiveEvent } from '@openbot/api-contract'
import { EventBus } from '@openbot/core'
import type { Db } from '@openbot/db'

/** What every procedure runs against; built once per server start, or per test by the harness. */
export type ServerContext = {
  db: Db
  bus: EventBus<LiveEvent>
}

export function createServerContext(db: Db): ServerContext {
  return { db, bus: new EventBus<LiveEvent>() }
}
