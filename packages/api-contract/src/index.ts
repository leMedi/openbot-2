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

const signInMethod = z.enum(['api_key', 'oauth'])

export const provider = z.object({
  id: z.string(),
  name: z.string(),
  /** How the provider is connected, or null when it isn't. */
  connection: z.object({ method: signInMethod }).nullable(),
  methods: z.array(z.object({ method: signInMethod, label: z.string(), subscription: z.boolean() })),
})
export type ProviderInfo = z.infer<typeof provider>

/** One step of a provider sign-in, streamed to the web wizard. Never carries a credential. */
export const signInStep = z.discriminatedUnion('type', [
  /** First step; its id addresses `providers.answer`. */
  z.object({ type: z.literal('started'), signInId: z.string() }),
  z.object({
    type: z.literal('info'),
    message: z.string(),
    links: z.array(z.object({ url: z.string(), label: z.string().optional() })),
  }),
  /** Open this URL in the browser to sign in. */
  z.object({ type: z.literal('auth_url'), url: z.string(), instructions: z.string().optional() }),
  z.object({
    type: z.literal('device_code'),
    userCode: z.string(),
    verificationUri: z.string(),
    expiresInSeconds: z.number().optional(),
  }),
  z.object({ type: z.literal('progress'), message: z.string() }),
  /**
   * Needs an answer through `providers.answer`. `manual_code` asks for the URL the browser was finally redirected
   * to, which completes subscription sign-ins when OpenBot runs on another machine.
   */
  z.object({
    type: z.literal('prompt'),
    promptId: z.string(),
    kind: z.enum(['text', 'secret', 'select', 'manual_code']),
    message: z.string(),
    placeholder: z.string().optional(),
    options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })).optional(),
  }),
  /** The prompt no longer needs an answer, e.g. the sign-in callback reached the server first. */
  z.object({ type: z.literal('prompt_closed'), promptId: z.string() }),
  /** Last step on success. */
  z.object({ type: z.literal('connected') }),
  /** Last step on failure. */
  z.object({ type: z.literal('failed'), message: z.string() }),
])
export type SignInStep = z.infer<typeof signInStep>

export const model = z.object({
  /** `provider/modelId`. */
  ref: z.string(),
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  /** Accepts images, so it can be the computer-use model. */
  vision: z.boolean(),
})
export type ModelInfo = z.infer<typeof model>

/** Model refs; null means "same as default" (for the default model itself: not chosen yet). */
export const modelSettings = z.object({
  defaultModel: z.string().nullable(),
  computerUseModel: z.string().nullable(),
})
export type ModelSettings = z.infer<typeof modelSettings>

export const contract = {
  health: oc
    .route({ method: 'GET', path: '/health', summary: 'Liveness, used by the installer and the updater' })
    .output(z.object({ status: z.literal('ok'), epoch: z.string() })),
  events: oc
    .route({ method: 'GET', path: '/events', summary: 'The live event stream, as server-sent events' })
    .output(eventIterator(stampedEvent)),
  providers: {
    list: oc
      .route({ method: 'GET', path: '/providers', summary: 'Every provider OpenBot can use, and whether it is connected' })
      .output(z.array(provider)),
    connect: oc
      .route({
        method: 'POST',
        path: '/providers/{providerId}/connect',
        summary: 'Run a sign-in, streaming its steps; closing the stream cancels it',
      })
      .input(z.object({ providerId: z.string(), method: signInMethod }))
      .output(eventIterator(signInStep)),
    answer: oc
      .route({ method: 'POST', path: '/sign-ins/{signInId}/answer', summary: 'Answer a prompt of a running sign-in' })
      .input(z.object({ signInId: z.string(), promptId: z.string(), value: z.string() }))
      .output(z.void()),
    disconnect: oc
      .route({ method: 'DELETE', path: '/providers/{providerId}/connection', summary: 'Forget the stored credential' })
      .input(z.object({ providerId: z.string() }))
      .output(z.void()),
  },
  models: {
    list: oc
      .route({ method: 'GET', path: '/models', summary: 'Models of connected providers' })
      .output(z.array(model)),
    getSettings: oc
      .route({ method: 'GET', path: '/settings/models', summary: 'The default and computer-use models' })
      .output(modelSettings),
    updateSettings: oc
      .route({
        method: 'PATCH',
        path: '/settings/models',
        summary: 'Set the default and computer-use models; the computer-use model must accept images',
      })
      .input(modelSettings.partial())
      .output(modelSettings),
  },
}

export type Contract = typeof contract
export type ApiClient = ContractRouterClient<Contract>

/** A typed client for the HTTP API at `url` (e.g. `https://host/api`), for the web app and later mobile. */
export function createApiClient(url: string): ApiClient {
  return createORPCClient(new OpenAPILink(contract, { url }))
}
