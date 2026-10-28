import { afterEach, describe, expect, it } from 'vitest'
import type { SignInStep } from '@openbot/api-contract'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
async function start() {
  const server = await createTestServer()
  servers.push(server)
  return server
}
async function restart(server: TestServer, options?: Parameters<typeof restartTestServer>[1]) {
  servers.splice(servers.indexOf(server), 1, await restartTestServer(server, options))
  return servers.at(-1)!
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

type Step = SignInStep

/** Drives a sign-in the way the web wizard does: reads steps from the stream and answers prompts. */
async function startSignIn(server: TestServer, providerId: string, method: 'api_key' | 'oauth') {
  const controller = new AbortController()
  const steps = await server.client.providers.connect({ providerId, method }, { signal: controller.signal })
  const seen: Step[] = []
  const next = async (): Promise<Step> => {
    const { done, value } = await steps.next()
    if (done) throw new Error(`Sign-in stream ended after ${JSON.stringify(seen)}`)
    seen.push(value)
    return value
  }
  const started = await next()
  if (started.type !== 'started') throw new Error(`Expected started, got ${started.type}`)

  return {
    seen,
    /** Reads steps until one of `type`, returning it. */
    async until<T extends Step['type']>(type: T): Promise<Extract<Step, { type: T }>> {
      for (;;) {
        const step = await next()
        if (step.type === type) return step as Extract<Step, { type: T }>
        if (step.type === 'failed') throw new Error(`Sign-in failed: ${step.message}`)
      }
    },
    answer: (promptId: string, value: string) =>
      server.client.providers.answer({ signInId: started.signInId, promptId, value }),
    /** Closes the stream, as when the owner closes the wizard. */
    close: () => controller.abort(),
  }
}

describe('providers', () => {
  it('lists every provider with its sign-in methods, none connected at first', async () => {
    const server = await start()

    const providers = await server.client.providers.list()

    expect(providers).toEqual([
      {
        id: 'fake',
        name: 'Fake',
        connection: null,
        methods: [
          { method: 'api_key', label: 'Fake API key', subscription: false },
          { method: 'oauth', label: 'Sign in with Fake Pro', subscription: true },
        ],
      },
      {
        id: 'fake-device',
        name: 'Fake Device',
        connection: null,
        methods: [{ method: 'oauth', label: 'Fake Device (Team plan)', subscription: true }],
      },
    ])
  })

  it('connects with an API key', async () => {
    const server = await start()

    const signIn = await startSignIn(server, 'fake', 'api_key')
    const prompt = await signIn.until('prompt')
    expect(prompt).toMatchObject({ kind: 'secret', message: 'Enter Fake API key' })
    await signIn.answer(prompt.promptId, 'sk-fake-123')
    await signIn.until('connected')

    const providers = await server.client.providers.list()
    expect(providers.find((provider) => provider.id === 'fake')?.connection).toEqual({ method: 'api_key' })
    expect(await server.client.models.list()).toEqual([
      { ref: 'fake/fake-model', provider: 'fake', id: 'fake-model', name: 'Fake Model', vision: true },
      { ref: 'fake/fake-mini', provider: 'fake', id: 'fake-mini', name: 'Fake Mini', vision: false },
    ])
  })

  it("connects with an API key from an environment given to it (evals, CI), never from the server's own", async () => {
    const server = await start()
    process.env.FAKE_API_KEY = 'sk-server-env'
    try {
      expect((await server.client.providers.list())[0]!.connection).toBeNull()
    } finally {
      delete process.env.FAKE_API_KEY
    }
    await expect(server.connectProviderFromEnv('fake', {})).rejects.toThrow(/No API key for fake/)

    expect(await server.connectProviderFromEnv('fake', { FAKE_API_KEY: 'sk-env' })).toBe('FAKE_API_KEY')

    expect((await server.client.providers.list())[0]!.connection).toEqual({ method: 'api_key' })
    const request = server.providers.answerNextRequest()
    expect(await server.complete('fake/fake-mini', { systemPrompt: 'Grade it', prompt: 'Rubric: …' })).toBe('ok')
    expect(request.apiKey).toBe('sk-env')
  })

  it('completes a subscription sign-in from the pasted redirect URL', async () => {
    const server = await start()

    const signIn = await startSignIn(server, 'fake', 'oauth')
    const authUrl = await signIn.until('auth_url')
    expect(authUrl.url).toMatch(/^https:\/\/fake\.test\/authorize\?state=/)
    const prompt = await signIn.until('prompt')
    expect(prompt.kind).toBe('manual_code')
    await signIn.answer(prompt.promptId, server.providers.signIn.redirectUrl('code-from-browser'))
    await signIn.until('connected')

    const providers = await server.client.providers.list()
    expect(providers.find((provider) => provider.id === 'fake')?.connection).toEqual({ method: 'oauth' })
  })

  it('closes the paste prompt when the sign-in callback reaches the server first', async () => {
    const server = await start()

    const signIn = await startSignIn(server, 'fake', 'oauth')
    const prompt = await signIn.until('prompt')
    server.providers.signIn.completeCallback('code-from-callback')

    expect(await signIn.until('prompt_closed')).toEqual({ type: 'prompt_closed', promptId: prompt.promptId })
    await signIn.until('connected')
    await expect(signIn.answer(prompt.promptId, 'too late')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports a sign-in that fails, without connecting', async () => {
    const server = await start()

    const signIn = await startSignIn(server, 'fake', 'oauth')
    const prompt = await signIn.until('prompt')
    await signIn.answer(prompt.promptId, 'http://localhost:1455/callback?code=x&state=forged')

    await expect(signIn.until('connected')).rejects.toThrow('State mismatch')
    const providers = await server.client.providers.list()
    expect(providers.find((provider) => provider.id === 'fake')?.connection).toBeNull()
  })

  it('shows the device code and verification link, after a choice', async () => {
    const server = await start()

    const signIn = await startSignIn(server, 'fake-device', 'oauth')
    const choice = await signIn.until('prompt')
    expect(choice).toMatchObject({
      kind: 'select',
      message: 'Which plan?',
      options: [
        { id: 'personal', label: 'Personal' },
        { id: 'team', label: 'Team', description: 'Shared with your organisation' },
      ],
    })
    await signIn.answer(choice.promptId, 'team')
    expect(await signIn.until('device_code')).toMatchObject({
      userCode: 'WXYZ-1234',
      verificationUri: 'https://fake.test/device',
    })
    server.providers.device.approve()
    await signIn.until('connected')

    expect((await server.client.models.list()).map((model) => model.ref)).toEqual(['fake-device/fake-text'])
  })

  it('cancels the sign-in when the wizard is closed', async () => {
    const server = await start()

    const signIn = await startSignIn(server, 'fake', 'api_key')
    const prompt = await signIn.until('prompt')
    signIn.close()

    await expect.poll(() => signIn.answer(prompt.promptId, 'sk-late').catch((error) => error.code)).toBe('NOT_FOUND')
    const providers = await server.client.providers.list()
    expect(providers.find((provider) => provider.id === 'fake')?.connection).toBeNull()
  })

  it('rejects sign-in methods a provider does not offer', async () => {
    const server = await start()

    await expect(startSignIn(server, 'fake-device', 'api_key')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(startSignIn(server, 'nope', 'api_key')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('disconnects a provider', async () => {
    const server = await start()
    await connectWithKey(server, 'sk-fake-123')

    await server.client.providers.disconnect({ providerId: 'fake' })

    const providers = await server.client.providers.list()
    expect(providers.find((provider) => provider.id === 'fake')?.connection).toBeNull()
    expect(await server.client.models.list()).toEqual([])
  })

  it('keeps connections across a restart', async () => {
    const before = await start()
    await connectWithKey(before, 'sk-fake-123')

    const after = await restart(before)

    const providers = await after.client.providers.list()
    expect(providers.find((provider) => provider.id === 'fake')?.connection).toEqual({ method: 'api_key' })
  })

  it('treats credentials sealed under a lost secret key as disconnected, so they can be connected again', async () => {
    const before = await start()
    await connectWithKey(before, 'sk-fake-123')

    const after = await restart(before, { secretKey: 'a-different-secret-key-than-before' })

    const providers = await after.client.providers.list()
    expect(providers.find((provider) => provider.id === 'fake')?.connection).toBeNull()
    await connectWithKey(after, 'sk-fake-456')
    expect(await after.client.models.list()).toHaveLength(2)
  })
})

async function connectWithKey(server: TestServer, key: string) {
  const signIn = await startSignIn(server, 'fake', 'api_key')
  await signIn.answer((await signIn.until('prompt')).promptId, key)
  await signIn.until('connected')
}

async function connectWithSubscription(server: TestServer) {
  const signIn = await startSignIn(server, 'fake', 'oauth')
  const prompt = await signIn.until('prompt')
  await signIn.answer(prompt.promptId, server.providers.signIn.redirectUrl('code'))
  await signIn.until('connected')
}

/** The API key a request to `fake/fake-model` was sent with. */
async function keyUsedByNextRequest(server: TestServer) {
  const request = server.providers.answerNextRequest()
  const model = server.models.getModel('fake', 'fake-model')!
  const reply = await server.models.complete(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] })
  expect(reply.stopReason).toBe('stop')
  return request.apiKey
}

describe('OAuth refresh', () => {
  it('refreshes an expired token on the next request and persists the refreshed token', async () => {
    const before = await start()
    before.providers.signIn.expired = true
    await connectWithSubscription(before)
    before.providers.signIn.expired = false

    expect(await keyUsedByNextRequest(before)).toBe('access-2')
    expect(before.providers.signIn.refreshCount).toBe(1)

    // A fresh process would refresh again if only the expired token had been kept.
    const after = await restart(before)
    expect(await keyUsedByNextRequest(after)).toBe('access-2')
    expect(after.providers.signIn.refreshCount).toBe(0)
  })
})

describe('model settings', () => {
  it('starts with no default model and the computer-use model following it', async () => {
    const server = await start()

    expect(await server.client.models.getSettings()).toEqual({ defaultModel: null, computerUseModel: null, memoryModel: null })
  })

  it('sets the default and computer-use models', async () => {
    const server = await start()
    await connectWithKey(server, 'sk-fake-123')

    const updated = await server.client.models.updateSettings({
      defaultModel: 'fake/fake-mini',
      computerUseModel: 'fake/fake-model',
    })

    expect(updated).toEqual({ defaultModel: 'fake/fake-mini', computerUseModel: 'fake/fake-model', memoryModel: null })
    expect(await server.client.models.getSettings()).toEqual(updated)
  })

  it('puts the computer-use model back to "same as each bot\'s model"', async () => {
    const server = await start()
    await connectWithKey(server, 'sk-fake-123')
    await server.client.models.updateSettings({ defaultModel: 'fake/fake-model', computerUseModel: 'fake/fake-model' })

    const updated = await server.client.models.updateSettings({ computerUseModel: null })

    expect(updated).toEqual({ defaultModel: 'fake/fake-model', computerUseModel: null, memoryModel: null })
  })

  it('sets the memory model, and puts it back to "same as default"', async () => {
    const server = await start()
    await connectWithKey(server, 'sk-fake-123')

    expect(await server.client.models.updateSettings({ defaultModel: 'fake/fake-model', memoryModel: 'fake/fake-mini' })).toMatchObject({ memoryModel: 'fake/fake-mini' })
    expect(await server.client.models.updateSettings({ memoryModel: null })).toMatchObject({ memoryModel: null })
    await expect(server.client.models.updateSettings({ memoryModel: 'fake-device/fake-text' })).rejects.toThrow(/not a model of a connected provider/)
  })

  it('only offers vision-capable models for computer use', async () => {
    const server = await start()
    await connectWithKey(server, 'sk-fake-123')

    await expect(server.client.models.updateSettings({ computerUseModel: 'fake/fake-mini' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(await server.client.models.getSettings()).toEqual({ defaultModel: null, computerUseModel: null, memoryModel: null })
  })

  it('only accepts models of connected providers', async () => {
    const server = await start()

    await expect(server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })
})
