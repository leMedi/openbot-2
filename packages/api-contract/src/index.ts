import { createORPCClient } from '@orpc/client'
import { type ContractRouterClient, eventIterator, oc } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { z } from 'zod'

export const liveEvent = z.discriminatedUnion('type', [
  /**
   * First event of every subscription. A new `epoch` means the server restarted and the client must refetch;
   * its `seq` is the last one already published, so every later event has a greater `seq`.
   */
  z.object({ type: z.literal('hello') }),
])
export type LiveEvent = z.infer<typeof liveEvent>

export const stampedEvent = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  event: liveEvent,
})
export type StampedEvent = z.infer<typeof stampedEvent>

export const contract = {
  health: oc
    .route({ method: 'GET', path: '/health', summary: 'Liveness, used by the installer and the updater' })
    .output(z.object({ status: z.literal('ok'), epoch: z.string() })),
  events: oc
    .route({ method: 'GET', path: '/events', summary: 'The live event stream, as server-sent events' })
    .output(eventIterator(stampedEvent)),
}

export type Contract = typeof contract
export type ApiClient = ContractRouterClient<Contract>

/** A typed client for the HTTP API at `url` (e.g. `https://host/api`), for the web app and later mobile. */
export function createApiClient(url: string): ApiClient {
  return createORPCClient(new OpenAPILink(contract, { url }))
}
