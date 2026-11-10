import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkInstance, classifyError, type CheckFetch } from './check.ts'

const health = { status: 'ok', epoch: 'e1', version: '1.4.0', instanceId: 'instance-1', apiVersion: 1 }
const onboarded = { profile: true, provider: true, defaultModel: true, bot: true, done: true }

type Answer = { status?: number; json?: unknown; text?: string } | Error | 'hang'

/** A fake network: each URL answers as given, any other URL is refused. Records the URLs asked. */
function network(answers: Record<string, Answer>) {
  const asked: string[] = []
  const fetch: CheckFetch = (url, { signal }) => {
    asked.push(url)
    const answer = answers[url] ?? new Error('Could not connect to the server.')
    if (answer === 'hang') {
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Fetch request has been canceled'))))
    }
    if (answer instanceof Error) return Promise.reject(answer)
    const body = answer.text ?? JSON.stringify(answer.json)
    return Promise.resolve({ ok: (answer.status ?? 200) < 300, status: answer.status ?? 200, text: () => Promise.resolve(body) })
  }
  return { fetch, asked }
}

const check = (candidates: string[], answers: Record<string, Answer>) =>
  checkInstance(candidates, { fetch: network(answers).fetch, platform: 'ios' })

describe('checking an instance address', () => {
  it('connects to the first address that answers as OpenBot, set up', async () => {
    const result = await check(['https://box.local', 'http://box.local:3000'], {
      'http://box.local:3000/api/health': { json: health },
      'http://box.local:3000/api/onboarding': { json: onboarded },
    })
    expect(result).toEqual({ kind: 'connected', url: 'http://box.local:3000', instanceId: 'instance-1', setUp: true })
  })

  it('prefers an earlier address over a later one when both answer', async () => {
    const result = await check(['https://box.local', 'http://box.local:3000'], {
      'https://box.local/api/health': { json: { ...health, instanceId: 'secure' } },
      'https://box.local/api/onboarding': { json: onboarded },
      'http://box.local:3000/api/health': { json: health },
      'http://box.local:3000/api/onboarding': { json: onboarded },
    })
    expect(result).toMatchObject({ kind: 'connected', url: 'https://box.local', instanceId: 'secure' })
  })

  it('says an instance whose onboarding is not done is not set up', async () => {
    const result = await check(['http://box.local:3000'], {
      'http://box.local:3000/api/health': { json: health },
      'http://box.local:3000/api/onboarding': { json: { ...onboarded, bot: false, done: false } },
    })
    expect(result).toEqual({ kind: 'connected', url: 'http://box.local:3000', instanceId: 'instance-1', setUp: false })
  })

  it("says that an address answering something else isn't OpenBot", async () => {
    for (const answer of [
      { status: 404, text: 'Not found' },
      { text: '<html>router login</html>' },
      { json: { status: 'ok' } },
      { json: { ...health, status: 'down' } },
    ]) {
      const result = await check(['http://box.local:3000'], { 'http://box.local:3000/api/health': answer })
      expect(result, JSON.stringify(answer)).toEqual({ kind: 'failed', url: 'http://box.local:3000', failure: { kind: 'notOpenBot' } })
    }
  })

  it('blocks on an instance older than the app, including one from before API versions', async () => {
    for (const answer of [{ ...health, apiVersion: 0 }, { status: 'ok', epoch: 'e1', version: '1.0.0' }]) {
      const result = await check(['http://box.local:3000'], { 'http://box.local:3000/api/health': { json: answer } })
      expect(result).toEqual({ kind: 'instanceTooOld', url: 'http://box.local:3000' })
    }
  })

  it('blocks on an instance newer than the app', async () => {
    const result = await check(['http://box.local:3000'], { 'http://box.local:3000/api/health': { json: { ...health, apiVersion: 2 } } })
    expect(result).toEqual({ kind: 'appTooOld', url: 'http://box.local:3000' })
  })

  it("reports the http address's failure over the guessed https one's", async () => {
    const result = await check(['https://box.local', 'http://box.local:3000'], {
      'https://box.local/api/health': new Error('A server with the specified hostname could not be found.'),
      'http://box.local:3000/api/health': new Error('Could not connect to the server.'),
    })
    expect(result).toEqual({ kind: 'failed', url: 'http://box.local:3000', failure: { kind: 'refused' } })
  })

  it("reports the http address's failure even when something else answered on the guessed https one", async () => {
    // Another server on :443 of the same machine says nothing about OpenBot on :3000.
    for (const answer of [new Error('The certificate for this server is invalid.'), { status: 404, text: '' }]) {
      const result = await check(['https://box.local', 'http://box.local:3000'], { 'https://box.local/api/health': answer })
      expect(result).toEqual({ kind: 'failed', url: 'http://box.local:3000', failure: { kind: 'refused' } })
    }
  })

  it("reports a Local Network denial on any address, as it's why nothing answered", async () => {
    const result = await check(['https://192.168.1.20', 'http://192.168.1.20:3000'], {
      'https://192.168.1.20/api/health': new Error('The Internet connection appears to be offline.'),
      'http://192.168.1.20:3000/api/health': new Error('The request timed out.'),
    })
    expect(result).toEqual({ kind: 'failed', url: 'https://192.168.1.20', failure: { kind: 'localNetwork' } })
  })

  it('reports a failure of the onboarding check', async () => {
    const result = await check(['http://box.local:3000'], {
      'http://box.local:3000/api/health': { json: health },
      'http://box.local:3000/api/onboarding': new Error('The request timed out.'),
    })
    expect(result).toEqual({ kind: 'failed', url: 'http://box.local:3000', failure: { kind: 'timeout' } })
  })

  it("says the phone is offline when it has no network, rather than what the error seems to say", async () => {
    // Android says a refusal in airplane mode, and iOS a Local Network denial for a local address.
    for (const error of ['java.net.ConnectException: Failed to connect to /192.168.1.20:3000', 'The Internet connection appears to be offline.']) {
      const result = await checkInstance(['http://192.168.1.20:3000'], {
        fetch: network({ 'http://192.168.1.20:3000/api/health': new Error(`fetch failed: ${error}`) }).fetch,
        platform: 'ios',
        offline: async () => true,
      })
      expect(result, error).toEqual({ kind: 'failed', url: 'http://192.168.1.20:3000', failure: { kind: 'offline' } })
    }
  })

  it("doesn't call an untrusted certificate or another server being offline", async () => {
    const result = await checkInstance(['https://box.local'], {
      fetch: network({ 'https://box.local/api/health': { status: 404, text: '' } }).fetch,
      platform: 'ios',
      offline: async () => true,
    })
    expect(result).toEqual({ kind: 'failed', url: 'https://box.local', failure: { kind: 'notOpenBot' } })
  })

  describe('with a clock', () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it('gives up on an address with no answer after 10 s', async () => {
      const result = check(['http://10.0.0.9:3000'], { 'http://10.0.0.9:3000/api/health': 'hang' })
      await vi.advanceTimersByTimeAsync(9_999)
      let settled = false
      void result.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await result).toEqual({ kind: 'failed', url: 'http://10.0.0.9:3000', failure: { kind: 'timeout' } })
    })

    it('tries the addresses together, so two silent ones take 10 s, not 20', async () => {
      const result = check(['https://10.0.0.9', 'http://10.0.0.9:3000'], {
        'https://10.0.0.9/api/health': 'hang',
        'http://10.0.0.9:3000/api/health': 'hang',
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await result).toEqual({ kind: 'failed', url: 'http://10.0.0.9:3000', failure: { kind: 'timeout' } })
    })

    it('waits 2 s at most for a silent https address once the http one answered', async () => {
      const result = check(['https://box.local', 'http://box.local:3000'], {
        'https://box.local/api/health': 'hang',
        'http://box.local:3000/api/health': { json: health },
        'http://box.local:3000/api/onboarding': { json: onboarded },
      })
      let settled = false
      void result.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(1_900)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toMatchObject({ kind: 'connected', url: 'http://box.local:3000' })
    })
  })
})

describe("classifying the errors the phone's fetch throws", () => {
  // As recorded from expo/fetch on the iOS simulator and the Android emulator.
  const fetchError = (text: string) => new Error(`fetch failed: ${text}`)

  it('reads iOS errors', () => {
    const url = 'http://192.168.1.20:3000'
    expect(classifyError(fetchError('A server with the specified hostname could not be found.'), url, 'ios')).toEqual({ kind: 'notFound' })
    expect(classifyError(fetchError('The request timed out.'), url, 'ios')).toEqual({ kind: 'timeout' })
    expect(classifyError(fetchError('Could not connect to the server.'), url, 'ios')).toEqual({ kind: 'refused' })
    expect(
      classifyError(
        fetchError(
          'The certificate for this server is invalid. You might be connecting to a server that is pretending to be “192.168.1.20” which could put your confidential information at risk.',
        ),
        'https://192.168.1.20',
        'ios',
      ),
    ).toEqual({ kind: 'certificate' })
    expect(classifyError(fetchError('A TLS error caused the secure connection to fail.'), 'https://192.168.1.20', 'ios')).toEqual({
      kind: 'other',
      detail: 'A TLS error caused the secure connection to fail.',
    })
  })

  it("reads iOS's offline error as a Local Network denial for a local address only", () => {
    const offline = fetchError('The Internet connection appears to be offline.')
    for (const url of ['http://192.168.1.20:3000', 'http://10.0.0.5:3000', 'http://172.20.1.1:3000', 'http://openbot.local:3000']) {
      expect(classifyError(offline, url, 'ios'), url).toEqual({ kind: 'localNetwork' })
    }
    for (const url of ['https://box.tail1234.ts.net', 'http://100.84.12.7:3000', 'http://172.40.1.1:3000']) {
      expect(classifyError(offline, url, 'ios'), url).toEqual({ kind: 'offline' })
    }
    expect(classifyError(offline, 'http://192.168.1.20:3000', 'android')).toEqual({ kind: 'offline' })
  })

  it('reads Android errors', () => {
    const url = 'http://192.168.1.20:3000'
    expect(
      classifyError(fetchError('java.net.UnknownHostException: Unable to resolve host "box.tail1234.ts.net": No address associated with hostname'), url, 'android'),
    ).toEqual({ kind: 'notFound' })
    expect(classifyError(fetchError('java.net.ConnectException: Failed to connect to /192.168.1.20:3000'), url, 'android')).toEqual({ kind: 'refused' })
    expect(
      classifyError(
        fetchError('javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.'),
        'https://192.168.1.20',
        'android',
      ),
    ).toEqual({ kind: 'certificate' })
    expect(classifyError(fetchError('javax.net.ssl.SSLException: Unable to parse TLS packet header'), 'https://192.168.1.20', 'android')).toEqual({
      kind: 'other',
      detail: 'Unable to parse TLS packet header',
    })
  })
})
