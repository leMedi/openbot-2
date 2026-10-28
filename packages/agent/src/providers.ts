import {
  type AuthContext,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type AuthType,
  type Credential,
  type Models,
  type Provider,
  createModels,
} from '@earendil-works/pi-ai'
import type { SecretBox } from '@openbot/core'
import type { Db } from '@openbot/db'
import { SystemCredentialStore } from './credential-store.ts'
import { SignInNotFoundError, type SignInStep, stepQueue } from './sign-in.ts'

export { SignInNotFoundError, type SignInStep } from './sign-in.ts'

export type SignInMethod = AuthType

/** A model vendor or subscription as pi defines it. */
export type ModelProvider = Provider

/** Every provider pi supports. Loaded on demand: it pulls in every model catalog. */
export async function builtinModelProviders(): Promise<ModelProvider[]> {
  const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all')
  return builtinProviders()
}

export type ProviderSummary = {
  id: string
  name: string
  /** How the provider is connected, or null when it isn't. */
  connection: { method: SignInMethod } | null
  methods: { method: SignInMethod; label: string; subscription: boolean }[]
}

export type ModelSummary = {
  /** `provider/modelId`, as stored in settings and on bots. */
  ref: string
  provider: string
  id: string
  name: string
  /** Accepts images, so it can drive a screen. */
  vision: boolean
}

/** Stored credentials are the only source: pi never reads the server's environment or files for keys. */
const noAmbientAuth: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
}

const toStep = (event: AuthEvent): SignInStep => {
  switch (event.type) {
    case 'info':
      return { type: 'info', message: event.message, links: [...(event.links ?? [])] }
    case 'auth_url':
      return { type: 'auth_url', url: event.url, instructions: event.instructions }
    case 'device_code':
      return {
        type: 'device_code',
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        expiresInSeconds: event.expiresInSeconds,
      }
    case 'progress':
      return { type: 'progress', message: event.message }
  }
}

/**
 * Model providers and their sign-ins, over pi-ai's `Models` with credentials in our encrypted store (ADR 0006).
 * pi refreshes expired OAuth tokens through the store on every request.
 */
export class Providers {
  /** pi's model collection, for the runtime; auth resolves (and refreshes) through our credential store. */
  readonly models: Models
  readonly #credentials: SystemCredentialStore
  readonly #signIns = new Map<string, Map<string, (answer: string) => void>>()

  constructor({ db, box, providers }: { db: Db; box: SecretBox; providers: readonly ModelProvider[] }) {
    this.#credentials = new SystemCredentialStore(db, box)
    const models = createModels({ credentials: this.#credentials, authContext: noAmbientAuth })
    for (const provider of providers) models.setProvider(provider)
    this.models = models
  }

  /**
   * Connects `providerId` with the API key its usual environment variables hold in `env` (e.g. `ANTHROPIC_API_KEY`),
   * stored like one the owner entered; for evals and CI, which have no owner to sign in. Returns the variable it used.
   * The server itself never reads keys from its environment.
   */
  async connectFromEnv(providerId: string, env: Record<string, string | undefined>): Promise<string> {
    const apiKey = this.models.getProvider(providerId)?.auth.apiKey
    if (!apiKey) throw new Error(`Provider ${providerId} doesn't exist or takes no API key`)
    const resolved = await apiKey.resolve({
      ctx: { env: async (name) => env[name] || undefined, fileExists: async () => false },
      signal: new AbortController().signal,
    })
    if (!resolved) throw new Error(`No API key for ${providerId} in the environment: set its usual variable, e.g. ANTHROPIC_API_KEY for anthropic`)
    const key = resolved.auth.apiKey
    // A provider that needs no key is connected already.
    if (key) {
      const credential: Credential = { type: 'api_key', key, ...(resolved.env && { env: resolved.env }) }
      await this.#credentials.modify(providerId, async () => credential)
    }
    return resolved.source ?? 'the environment'
  }

  /**
   * One request to the model `ref` (`provider/modelId`) of a connected provider, answered in text; for the eval judge.
   * Throws when the provider fails the request.
   */
  async complete(ref: string, { systemPrompt, prompt }: { systemPrompt: string; prompt: string }): Promise<string> {
    const slash = ref.indexOf('/')
    const model = this.models.getModel(ref.slice(0, slash), ref.slice(slash + 1))
    if (!model) throw new Error(`No model ${ref}`)
    const reply = await this.models.completeSimple(
      model,
      { systemPrompt, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] },
      // A fresh session per request: some providers (OpenCode Go) refuse requests without one.
      { sessionId: crypto.randomUUID() },
    )
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `${ref} failed the request`)
    return reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  }

  async list(): Promise<ProviderSummary[]> {
    return Promise.all(
      this.models.getProviders().map(async (provider) => {
        const check = await this.models.checkAuth(provider.id)
        const methods: ProviderSummary['methods'] = []
        const { apiKey, oauth } = provider.auth
        if (apiKey?.login) methods.push({ method: 'api_key', label: apiKey.name, subscription: false })
        if (oauth) methods.push({ method: 'oauth', label: oauth.loginLabel ?? oauth.name, subscription: !!oauth.isSubscription })
        return { id: provider.id, name: provider.name, connection: check ? { method: check.type } : null, methods }
      }),
    )
  }

  /** Models of connected providers. */
  async listModels(): Promise<ModelSummary[]> {
    return (await this.models.getAvailable()).map((model) => ({
      ref: `${model.provider}/${model.id}`,
      provider: model.provider,
      id: model.id,
      name: model.name,
      vision: model.input.includes('image'),
    }))
  }

  async findModel(ref: string): Promise<ModelSummary | undefined> {
    return (await this.listModels()).find((model) => model.ref === ref)
  }

  /**
   * Runs pi's sign-in for `providerId`, yielding each step for the wizard. Prompts are answered with `answer`.
   * Ending the iteration early (or aborting `signal`) cancels the sign-in.
   */
  async *signIn(providerId: string, method: SignInMethod, signal?: AbortSignal): AsyncGenerator<SignInStep> {
    const signInId = crypto.randomUUID()
    const steps = stepQueue()
    const pending = new Map<string, (answer: string) => void>()
    const cancel = new AbortController()
    const onAbort = () => cancel.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort)
    this.#signIns.set(signInId, pending)

    const interaction: AuthInteraction = {
      signal: cancel.signal,
      notify: (event) => steps.push(toStep(event)),
      prompt: (prompt) => this.#prompt(prompt, pending, steps.push, cancel.signal),
    }

    steps.push({ type: 'started', signInId })
    this.models.login(providerId, method, interaction).then(
      () => steps.push({ type: 'connected' }),
      (error: unknown) => {
        if (!cancel.signal.aborted) steps.push({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    ).finally(steps.close)

    try {
      yield* steps.drain()
    } finally {
      cancel.abort()
      signal?.removeEventListener('abort', onAbort)
      this.#signIns.delete(signInId)
    }
  }

  /** Answers an open prompt of a running sign-in. */
  answer(signInId: string, promptId: string, value: string) {
    const resolve = this.#signIns.get(signInId)?.get(promptId)
    if (!resolve) throw new SignInNotFoundError(`No open prompt ${promptId} in sign-in ${signInId}`)
    resolve(value)
  }

  async disconnect(providerId: string) {
    await this.models.logout(providerId)
  }

  #prompt(
    prompt: AuthPrompt,
    pending: Map<string, (answer: string) => void>,
    push: (step: SignInStep) => void,
    signInSignal: AbortSignal,
  ): Promise<string> {
    const promptId = crypto.randomUUID()
    return new Promise<string>((resolve, reject) => {
      const signals = [signInSignal, prompt.signal].filter((signal) => signal !== undefined)
      const close = (reason: unknown) => {
        if (!pending.delete(promptId)) return
        push({ type: 'prompt_closed', promptId })
        reject(reason)
      }
      for (const signal of signals) signal.addEventListener('abort', () => close(signal.reason), { once: true })
      pending.set(promptId, (answer) => {
        pending.delete(promptId)
        resolve(answer)
      })
      push({
        type: 'prompt',
        promptId,
        kind: prompt.type,
        message: prompt.message,
        ...('placeholder' in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.type === 'select' ? { options: [...prompt.options] } : {}),
      })
      const aborted = signals.find((signal) => signal.aborted)
      if (aborted) close(aborted.reason)
    })
  }
}
