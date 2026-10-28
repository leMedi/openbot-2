import { request } from 'node:http'
import type { ComputerBot, ScreenBot, ScreenListing, Screens, ScreenStatus } from '@openbot/core'
import type { DaemonError, Health, StartScreenRequest } from './protocol.ts'

/** The screen daemon couldn't be reached or refused a request. */
export class ScreenDaemonError extends Error {}

/**
 * The screens of the real computer, kept by the screen daemon listening on `socketPath`. While anyone listens for its
 * restarts, its health is checked every `checkEvery` ms.
 */
export function connectScreens({
  socketPath,
  timeout = 10_000,
  checkEvery = 2_000,
}: {
  socketPath: string
  timeout?: number
  checkEvery?: number
}): Screens {
  function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request(
        {
          socketPath,
          method,
          path,
          timeout,
          headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown
            try {
              parsed = text ? JSON.parse(text) : undefined
            } catch {
              return reject(new ScreenDaemonError(`The screen daemon answered ${res.statusCode} with ${text.slice(0, 200)}`))
            }
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new ScreenDaemonError((parsed as DaemonError | undefined)?.error ?? `The screen daemon answered ${res.statusCode}`))
            }
            resolve(parsed as T)
          })
          res.on('error', reject)
        },
      )
      req.on('timeout', () => req.destroy(new ScreenDaemonError('The screen daemon took too long to answer')))
      req.on('error', (error) =>
        reject(error instanceof ScreenDaemonError ? error : new ScreenDaemonError(`Can't reach the screen daemon at ${socketPath}: ${error.message}`)),
      )
      req.end(payload)
    })
  }

  const path = (bot: ComputerBot) => `/screens/${encodeURIComponent(bot.id)}`

  const restartListeners = new Set<() => void>()
  /** The daemon's boot as last reached; a different one means it restarted. */
  let bootId: string | undefined
  let checking = false
  let checker: ReturnType<typeof setInterval> | undefined

  async function check() {
    if (checking) return
    checking = true
    let restarted = false
    try {
      const health = await call<Health>('GET', '/health')
      restarted = bootId !== undefined && health.bootId !== bootId
      bootId = health.bootId
    } catch {
      // Not up (yet): its next boot is told apart from the last one reached.
    } finally {
      checking = false
    }
    if (restarted) for (const listener of [...restartListeners]) listener()
  }

  return {
    start: (bot: ScreenBot) => call<ScreenStatus>('PUT', path(bot), { display: bot.display } satisfies StartScreenRequest),
    stop: async (bot) => {
      await call<void>('DELETE', path(bot))
    },
    status: (bot) => call<ScreenStatus>('GET', path(bot)),
    list: () => call<ScreenListing[]>('GET', '/screens'),
    onRestart(listener) {
      // Its own entry, so one listener added twice is told twice and removed once.
      const entry = () => listener()
      restartListeners.add(entry)
      if (!checker) {
        void check()
        checker = setInterval(check, checkEvery).unref()
      }
      return () => {
        restartListeners.delete(entry)
        if (restartListeners.size === 0) {
          clearInterval(checker)
          checker = undefined
        }
      }
    },
  }
}
