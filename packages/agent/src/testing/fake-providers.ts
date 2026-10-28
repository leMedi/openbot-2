import {
  type AssistantMessage,
  type FauxModelDefinition,
  type FauxResponseFactory,
  type Message,
  type Model,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuth,
  createFauxCore,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai'
import { HeldTurn } from './fake-model.ts'

/** Sign-ins are scripted in tests; tokens they mint are good for an hour unless `expired` is set. */
const tokenLifetimeMs = 60 * 60 * 1000

/**
 * A faux provider whose sign-in methods the test supplies. Models in `apart` answer from their own queue, `faux` of
 * `apart`, instead of the provider's `faux` queue the other models share.
 */
function fauxProviderWith(id: string, name: string, models: FauxModelDefinition[], auth: ProviderAuth, apart: FauxModelDefinition[] = []) {
  const api = `faux-${id}`
  const faux = createFauxCore({ api, provider: id, models })
  const own = apart.length ? createFauxCore({ api, provider: id, models: apart }) : undefined
  const ownIds = new Set(apart.map((model) => model.id))
  const core = (model: Model<string>) => (own && ownIds.has(model.id) ? own : faux)
  const provider = createProvider({
    id,
    name,
    auth,
    models: [...faux.models, ...(own?.models ?? [])],
    api: {
      stream: (model, context, options) => core(model).stream(model, context, options),
      streamSimple: (model, context, options) => core(model).streamSimple(model, context, options),
    },
  })
  return { faux, apart: own, provider }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

/**
 * A subscription sign-in like Claude Pro's: the browser is sent to `auth_url`, then either the loopback callback
 * arrives (`completeCallback`) or the owner pastes the URL they were redirected to.
 */
function createLoopbackSignIn() {
  let callback = deferred<string>()
  let state = ''
  let mintedTokens = 0
  let refreshes = 0
  let expired = false

  const mint = (): OAuthCredential => ({
    type: 'oauth',
    access: `access-${++mintedTokens}`,
    refresh: `refresh-${mintedTokens}`,
    expires: expired ? Date.now() - 1 : Date.now() + tokenLifetimeMs,
  })

  const oauth: OAuthAuth = {
    name: 'Fake (Fake Pro)',
    isSubscription: true,
    loginLabel: 'Sign in with Fake Pro',
    async login(interaction) {
      state = crypto.randomUUID()
      callback = deferred<string>()
      interaction.notify({ type: 'auth_url', url: `https://fake.test/authorize?state=${state}` })
      const manual = new AbortController()
      const pasted = interaction
        .prompt({ type: 'manual_code', message: 'Paste the URL you were redirected to', signal: manual.signal })
        .then((url) => {
          const redirect = new URL(url)
          if (redirect.searchParams.get('state') !== state) throw new Error('State mismatch')
          return redirect.searchParams.get('code')!
        })
      const code = await Promise.race([pasted, callback.promise])
      manual.abort()
      pasted.catch(() => {})
      interaction.notify({ type: 'progress', message: 'Exchanging authorization code for tokens…' })
      return mint()
    },
    async refresh() {
      refreshes++
      return mint()
    },
    async toAuth(credential) {
      return { apiKey: credential.access }
    },
  }

  return {
    oauth,
    /** The URL the browser lands on after approving, as the owner would copy it from the address bar. */
    redirectUrl: (code: string) => `http://localhost:1455/callback?code=${code}&state=${state}`,
    /** The loopback callback server receives the code, as when OpenBot runs on the owner's machine. */
    completeCallback: (code: string) => callback.resolve(code),
    /** Makes later sign-ins and refreshes mint tokens that have already expired (or not). */
    set expired(value: boolean) {
      expired = value
    },
    get refreshCount() {
      return refreshes
    },
  }
}

/** A device-code sign-in that first asks which plan to use, approved out of band with `approve()`. */
function createDeviceSignIn() {
  let approval = deferred<void>()

  const oauth: OAuthAuth = {
    name: 'Fake Device (Team plan)',
    isSubscription: true,
    async login(interaction) {
      approval = deferred<void>()
      await interaction.prompt({
        type: 'select',
        message: 'Which plan?',
        options: [
          { id: 'personal', label: 'Personal' },
          { id: 'team', label: 'Team', description: 'Shared with your organisation' },
        ],
      })
      interaction.notify({ type: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://fake.test/device' })
      await approval.promise
      return { type: 'oauth', access: 'device-access', refresh: 'device-refresh', expires: Date.now() + tokenLifetimeMs }
    },
    async refresh(credential) {
      return { ...credential, expires: Date.now() + tokenLifetimeMs }
    },
    async toAuth(credential) {
      return { apiKey: credential.access }
    },
  }

  return { oauth, approve: () => approval.resolve() }
}

/** The tools a request offers: system messages add and remove them in order. */
function toolNames(messages: readonly Message[]): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) names.add(tool.name)
  }
  return [...names]
}

/**
 * Two scripted providers for Seam 1 tests, standing in for pi's built-in ones:
 * - `fake` (models `fake-model`, vision, and `fake-mini`, text only): API key (`FAKE_API_KEY` from an environment) or a
 *   loopback subscription sign-in. With `memoryModel`, also `fake-memory` (text only), scripted apart from the others
 *   through `memoryModel`, for side calls such as memory extraction.
 * - `fake-device` (model `fake-text`, text only): device-code sign-in only.
 */
export function createFakeProviders({ memoryModel = false }: { memoryModel?: boolean } = {}) {
  const signIn = createLoopbackSignIn()
  const device = createDeviceSignIn()
  const fake = fauxProviderWith(
    'fake',
    'Fake',
    [
      { id: 'fake-model', name: 'Fake Model', input: ['text', 'image'] },
      { id: 'fake-mini', name: 'Fake Mini', input: ['text'] },
    ],
    { apiKey: envApiKeyAuth('Fake API key', ['FAKE_API_KEY']), oauth: signIn.oauth },
    memoryModel ? [{ id: 'fake-memory', name: 'Fake Memory', input: ['text'] }] : [],
  )
  const fakeDevice = fauxProviderWith('fake-device', 'Fake Device', [{ id: 'fake-text', input: ['text'] }], {
    oauth: device.oauth,
  })

  const requests: { model: string; messages: Message[]; tools: string[] }[] = []
  /** Turns scripted for one bot, by name; see `scriptFor`. */
  const botTurns = new Map<string, (AssistantMessage | HeldTurn)[]>()
  const answer = (turn: AssistantMessage | HeldTurn, signal: AbortSignal | undefined) =>
    turn instanceof HeldTurn ? turn.answer(signal) : turn
  /** Responses that record their request, then answer with `turns` in order. */
  const recorded = (turns: (AssistantMessage | HeldTurn)[]): FauxResponseFactory[] =>
    turns.map((turn) => (context, options, _state, model) => {
      requests.push({ model: `${model.provider}/${model.id}`, messages: [...context.messages], tools: toolNames(context.messages) })
      return answer(turn, options?.signal)
    })

  return {
    providers: [fake.provider, fakeDevice.provider] as Provider[],
    /** Queues responses of `fake` models, one per request in order; build them with `callsTools`, `says`, `held`… */
    script(...turns: (AssistantMessage | HeldTurn)[]) {
      fake.faux.appendResponses(recorded(turns))
    },
    /**
     * `fake/fake-memory`, when asked for with `memoryModel`: its responses are queued apart from the other `fake`
     * models', so side calls are scripted independently of bots' runs. Its requests are in `requests` too.
     */
    memoryModel: {
      ref: 'fake/fake-memory',
      /** Queues responses of the memory model, one per request in order. */
      script(...turns: (AssistantMessage | HeldTurn)[]) {
        if (!fake.apart) throw new Error('No memory model: create the fake providers with `memoryModel: true`')
        fake.apart.appendResponses(recorded(turns))
      },
      /** Its scripted turns not requested yet. */
      get pendingTurns() {
        return fake.apart?.getPendingResponseCount() ?? 0
      },
    },
    /**
     * Queues responses for the bot named `name` alone, one per request of its own in order, so bots working at once
     * each get theirs whichever asks first. A request goes to the bot whose prompt says "You are <name>".
     */
    scriptFor(name: string, ...turns: (AssistantMessage | HeldTurn)[]) {
      botTurns.set(name, [...(botTurns.get(name) ?? []), ...turns])
      fake.faux.appendResponses(
        turns.map(() => (context, options, _state, model) => {
          const text = JSON.stringify(context.messages)
          const bot = [...botTurns.keys()].find((candidate) => text.includes(`You are ${candidate},`) || text.includes(`You are ${candidate}.`))
          const turn = bot && botTurns.get(bot)!.shift()
          if (!turn) throw new Error(`No turn scripted for this request (${bot ?? 'no scripted bot'})`)
          requests.push({ model: `${model.provider}/${model.id}`, messages: [...context.messages], tools: toolNames(context.messages) })
          return answer(turn, options?.signal)
        }),
      )
    },
    /** Requests that scripted turns answered, in order: the model, the messages it was sent and its tools' names. */
    requests,
    /** Scripted turns not requested yet. */
    get pendingTurns() {
      return fake.faux.getPendingResponseCount()
    },
    /** Answers the next request to a `fake` model with "ok", recording the API key it was sent with. */
    answerNextRequest() {
      const request: { apiKey?: string } = {}
      fake.faux.appendResponses([
        (_context, options) => {
          request.apiKey = options?.apiKey
          return fauxAssistantMessage('ok')
        },
      ])
      return request as { readonly apiKey?: string }
    },
    signIn,
    device,
  }
}

export type FakeProviders = ReturnType<typeof createFakeProviders>
