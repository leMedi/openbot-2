import {
  type AssistantMessage,
  type FauxModelDefinition,
  type Message,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuth,
  createFauxCore,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai'

/** Sign-ins are scripted in tests; tokens they mint are good for an hour unless `expired` is set. */
const tokenLifetimeMs = 60 * 60 * 1000

/** A faux provider whose sign-in methods the test supplies. */
function fauxProviderWith(id: string, name: string, models: FauxModelDefinition[], auth: ProviderAuth) {
  const faux = createFauxCore({ provider: id, models })
  const provider = createProvider({
    id,
    name,
    auth,
    models: faux.models,
    api: { stream: faux.stream, streamSimple: faux.streamSimple },
  })
  return { faux, provider }
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

/**
 * Two scripted providers for Seam 1 tests, standing in for pi's built-in ones:
 * - `fake` (models `fake-model`, vision, and `fake-mini`, text only): API key or a loopback subscription sign-in.
 * - `fake-device` (model `fake-text`, text only): device-code sign-in only.
 */
export function createFakeProviders() {
  const signIn = createLoopbackSignIn()
  const device = createDeviceSignIn()
  const fake = fauxProviderWith(
    'fake',
    'Fake',
    [
      { id: 'fake-model', name: 'Fake Model', input: ['text', 'image'] },
      { id: 'fake-mini', name: 'Fake Mini', input: ['text'] },
    ],
    { apiKey: envApiKeyAuth('Fake API key', []), oauth: signIn.oauth },
  )
  const fakeDevice = fauxProviderWith('fake-device', 'Fake Device', [{ id: 'fake-text', input: ['text'] }], {
    oauth: device.oauth,
  })

  const requests: { model: string; messages: Message[] }[] = []

  return {
    providers: [fake.provider, fakeDevice.provider] as Provider[],
    /** Queues responses of `fake` models, one per request in order; build them with `callsTools`, `says`… */
    script(...turns: AssistantMessage[]) {
      fake.faux.appendResponses(
        turns.map((turn) => (context, _options, _state, model) => {
          requests.push({ model: `${model.provider}/${model.id}`, messages: [...context.messages] })
          return turn
        }),
      )
    },
    /** Requests that scripted turns answered, in order: the model and the messages it was sent. */
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
