import { request } from 'node:http'
import type { ComputerBot, ScreenBot, ScreenListing, Screens, ScreenStatus } from '@openbot/core'
import { bootHeader, type DaemonError, type Health, type StartScreenRequest } from './protocol.ts'

/** How long the daemon may take to open a bot's browser: its own wait for Chrome, and some. */
const browserOpenTimeout = 40_000

/** The screen daemon couldn't be reached or refused a request. */
export class ScreenDaemonError extends Error {}

/**
 * The screens of the real computer, kept by the screen daemon listening on `socketPath`. Every answer names the daemon's
 * boot, so any call can find it restarted; while anyone listens for restarts, its health is also checked every
 * `checkEvery` ms.
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
  function call<T>(method: string, path: string, body?: unknown, { wait = timeout }: { wait?: number } = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request(
        {
          socketPath,
          method,
          path,
          timeout: wait,
          headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const boot = res.headers[bootHeader]
          if (typeof boot === 'string') noticeBoot(boot)
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

  /** Tells the listeners when an answer comes from another boot than the last one. */
  function noticeBoot(boot: string) {
    const restarted = bootId !== undefined && boot !== bootId
    bootId = boot
    if (!restarted) return
    // Apart from the answer being read, so a listener's own calls and errors stay out of it.
    queueMicrotask(() => {
      for (const listener of [...restartListeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[screens] A listener for the screen daemon restarting failed:', error)
        }
      }
    })
  }

  async function check() {
    if (checking) return
    checking = true
    try {
      await call<Health>('GET', '/health')
    } catch {
      // Not up (yet): its next boot is told apart from the last one reached.
    } finally {
      checking = false
    }
  }

  return {
    start: (bot: ScreenBot) => call<ScreenStatus>('PUT', path(bot), { display: bot.display } satisfies StartScreenRequest),
    stop: async (bot) => {
      await call<void>('DELETE', path(bot))
    },
    status: (bot) => call<ScreenStatus>('GET', path(bot)),
    openBrowser: async (bot) => {
      // Chrome can take a while to start, more than other calls are given.
      await call<void>('POST', `${path(bot)}/browser`, undefined, { wait: Math.max(timeout, browserOpenTimeout) })
    },
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
