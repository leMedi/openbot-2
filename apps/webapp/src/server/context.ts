import { type ModelProvider, Providers } from '@openbot/agent'
import type { LiveEvent } from '@openbot/api-contract'
import { EventBus, SecretBox } from '@openbot/core'
import type { Db } from '@openbot/db'

/** What every procedure runs against; built once per server start, or per test by the harness. */
export type ServerContext = {
  db: Db
  bus: EventBus<LiveEvent>
  providers: Providers
}

export function createServerContext({
  db,
  secretKey,
  providers,
}: {
  db: Db
  /** Encrypts system credentials. */
  secretKey: string
  /** pi's model providers: all built-in ones in production, scripted fakes in tests. */
  providers: readonly ModelProvider[]
}): ServerContext {
  return {
    db,
    bus: new EventBus<LiveEvent>(),
    providers: new Providers({ db, box: new SecretBox(secretKey), providers }),
  }
}
