import { contract } from '@openbot/api-contract'
import { implement } from '@orpc/server'
import type { ServerContext } from './context.ts'

const os = implement(contract).$context<ServerContext>()

export const router = os.router({
  health: os.health.handler(async ({ context }) => {
    await context.db.$client.execute('select 1')
    return { status: 'ok' as const, epoch: context.bus.epoch }
  }),

  events: os.events.handler(async function* ({ context, signal }) {
    // Subscribe before greeting so nothing published in between is lost.
    const live = context.bus.subscribe(signal)
    yield { epoch: context.bus.epoch, seq: context.bus.seq, event: { type: 'hello' as const } }
    yield* live
  }),
})

export type Router = typeof router
