import { apiVersion } from '@openbot/api-contract'

/** How long an address may take to answer before it counts as silent (spec: Connect flow). */
export const checkTimeoutMs = 10_000
/** How long a guessed https address may still take once a later http one answered as OpenBot. */
const preferSecureGraceMs = 2_000

/** The slice of `fetch` the check needs, so tests can fake the network. */
export type CheckFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** Why an address couldn't be used, each with its own message on Connect and in the banner's diagnosis. */
export type Failure =
  | { kind: 'notFound' | 'timeout' | 'refused' | 'certificate' | 'notOpenBot' | 'localNetwork' | 'offline' }
  | { kind: 'other'; detail: string }

export type CheckResult =
  /** OpenBot answered at `url`; `setUp` once its onboarding is done. */
  | { kind: 'connected'; url: string; instanceId: string; setUp: boolean }
  /** OpenBot answered with an API version older than the app's: update the instance. */
  | { kind: 'instanceTooOld'; url: string }
  /** OpenBot answered with an API version newer than the app's: update the app. */
  | { kind: 'appTooOld'; url: string }
  /** No address worked; `url` is the one whose failure is reported. */
  | { kind: 'failed'; url: string; failure: Failure }

export type CheckOptions = {
  fetch: CheckFetch
  platform: 'ios' | 'android'
  timeoutMs?: number
  /**
   * Whether the phone has no network, asked when nothing answered: errors don't say it reliably (Android reports a
   * refusal in airplane mode, iOS's offline error is also its Local Network denial).
   */
  offline?: () => Promise<boolean>
}

type Probe =
  | { kind: 'failed'; failure: Failure }
  | { kind: 'openbot'; instanceId: string; apiVersion: number | undefined }

class Timeout extends Error {}

/**
 * Checks the instance addresses `candidates` (best first, from `candidateUrls`): each one's `GET /api/health` must
 * answer as OpenBot within 10 s, all tried at once. The best one that answered wins, waiting for a better one that
 * hasn't failed yet at most 2 s more. Then its API version must be the app's, and `/api/onboarding` says whether it's
 * set up. When none answered, the failure reported is the last address's (the http one, as the https one was only
 * a guess: another server there says nothing about OpenBot), unless iOS denied the local network on any of them, or
 * the phone is offline when it has no network.
 */
export async function checkInstance(candidates: readonly string[], options: CheckOptions): Promise<CheckResult> {
  if (!candidates.length) throw new Error('No address to check')
  const result = await check(candidates, options)
  if (result.kind === 'failed' && unanswered.includes(result.failure.kind) && (await options.offline?.().catch(() => false))) {
    return { ...result, failure: { kind: 'offline' } }
  }
  return result
}

/** Failures where nothing answered, which no network explains. */
const unanswered: Failure['kind'][] = ['notFound', 'timeout', 'refused', 'localNetwork', 'other']

async function check(candidates: readonly string[], options: CheckOptions): Promise<CheckResult> {
  const abandon = new AbortController()
  try {
    const { url, probe } = await best(
      candidates.map((url) => probeHealth(url, options, abandon.signal)),
      candidates,
    )
    if (probe.kind === 'failed') return { kind: 'failed', url, failure: probe.failure }
    if (probe.apiVersion === undefined || probe.apiVersion < apiVersion) return { kind: 'instanceTooOld', url }
    if (probe.apiVersion > apiVersion) return { kind: 'appTooOld', url }
    try {
      const onboarding = parseJson(await get(`${url}/api/onboarding`, options, abandon.signal))
      if (!isRecord(onboarding) || typeof onboarding.done !== 'boolean') return { kind: 'failed', url, failure: { kind: 'notOpenBot' } }
      return { kind: 'connected', url, instanceId: probe.instanceId, setUp: onboarding.done }
    } catch (error) {
      return { kind: 'failed', url, failure: classifyError(error, url, options.platform) }
    }
  } finally {
    abandon.abort()
  }
}

/** Waits for the probes until the best one that answered as OpenBot can be picked, or all have failed. */
function best(probes: Promise<Probe>[], candidates: readonly string[]): Promise<{ url: string; probe: Probe }> {
  return new Promise((resolve) => {
    const settled: (Probe | undefined)[] = probes.map(() => undefined)
    let grace: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = (index: number) => {
      done = true
      clearTimeout(grace)
      resolve({ url: candidates[index]!, probe: settled[index]! })
    }
    const answered = () => settled.findIndex((probe) => probe?.kind === 'openbot')
    const decide = () => {
      if (done) return
      const first = answered()
      if (first >= 0) {
        if (settled.slice(0, first).every((probe) => probe?.kind === 'failed')) return finish(first)
        grace ??= setTimeout(() => finish(answered()), preferSecureGraceMs)
        return
      }
      if (settled.every((probe) => probe)) finish(mostTelling(settled as Probe[]))
    }
    probes.forEach((probe, index) =>
      void probe.then((result) => {
        settled[index] = result
        decide()
      }),
    )
  })
}

function mostTelling(failures: Probe[]): number {
  const denied = failures.findIndex((probe) => probe.kind === 'failed' && probe.failure.kind === 'localNetwork')
  return denied >= 0 ? denied : failures.length - 1
}

async function probeHealth(url: string, options: CheckOptions, signal: AbortSignal): Promise<Probe> {
  try {
    const health = parseJson(await get(`${url}/api/health`, options, signal))
    if (!isRecord(health) || health.status !== 'ok' || typeof health.epoch !== 'string' || typeof health.version !== 'string') {
      return { kind: 'failed', failure: { kind: 'notOpenBot' } }
    }
    // An instance from before API versions has neither, and is older than any app that checks them.
    const known = typeof health.instanceId === 'string' && Number.isInteger(health.apiVersion)
    return { kind: 'openbot', instanceId: known ? (health.instanceId as string) : '', apiVersion: known ? (health.apiVersion as number) : undefined }
  } catch (error) {
    return { kind: 'failed', failure: classifyError(error, url, options.platform) }
  }
}

/** GETs `url` within the timeout, answering its body, or undefined when the status isn't a success. */
async function get(url: string, { fetch, timeoutMs = checkTimeoutMs }: CheckOptions, abandon: AbortSignal): Promise<string | undefined> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const stop = () => controller.abort()
  abandon.addEventListener('abort', stop)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const body = await response.text()
    return response.ok ? body : undefined
  } catch (error) {
    throw timedOut ? new Timeout() : error
  } finally {
    clearTimeout(timer)
    abandon.removeEventListener('abort', stop)
  }
}

function parseJson(body: string | undefined): unknown {
  if (body === undefined) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * What a failed request to `url` means, from the error `fetch` threw. `expo/fetch` gives only the native error's text:
 * iOS's NSURLError description (in the phone's language, so other languages fall to `other` with the text shown) or
 * Android's OkHttp exception.
 */
export function classifyError(error: unknown, url: string, platform: 'ios' | 'android'): Failure {
  if (error instanceof Timeout) return { kind: 'timeout' }
  const detail = errorText(error)
  const text = detail.toLowerCase()
  if (/hostname could not be found|unable to resolve host|unknownhostexception|no address associated/.test(text)) return { kind: 'notFound' }
  if (/timed out|sockettimeoutexception|\btimeout\b/.test(text)) return { kind: 'timeout' }
  if (/certificate|certpath|trust anchor|sslpeerunverified/.test(text)) return { kind: 'certificate' }
  if (/could not connect to the server|econnrefused|connection refused|failed to connect to/.test(text)) return { kind: 'refused' }
  if (/internet connection appears to be offline|not connected to the internet|enetunreach|network is unreachable/.test(text)) {
    // iOS answers a denied Local Network permission as being offline.
    return platform === 'ios' && isLocalAddress(url) ? { kind: 'localNetwork' } : { kind: 'offline' }
  }
  // Without `fetch failed: ` and a Java exception's class name, so it reads as a sentence.
  return { kind: 'other', detail: detail.replace(/^(fetch failed: )+/i, '').replace(/^([\w$]+\.)+[\w$]*(Exception|Error): /, '') }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? ` ${error.cause.message}` : ''
  return `${error.message}${cause}`
}

/** Whether `url`'s host is on the local network, which iOS's Local Network permission covers. */
export function isLocalAddress(url: string): boolean {
  const host = new URL(url).hostname
  if (host.endsWith('.local')) return true
  const ip = host.split('.').map(Number)
  if (ip.length !== 4 || ip.some((part) => !Number.isInteger(part))) return false
  const [a, b] = ip as [number, number]
  return a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254)
}
