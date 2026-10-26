import type { LiveEvent } from '@openbot/api-contract'
import type { EventBus } from '@openbot/core'
import type { Db } from '@openbot/db'

/** What every procedure runs against; built once per server start, or per test by the harness. */
export type ServerContext = {
  db: Db
  bus: EventBus<LiveEvent>
}
