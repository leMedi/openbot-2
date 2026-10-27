import { request } from 'node:http'
import type { ComputerBot, ScreenBot, ScreenListing, Screens, ScreenStatus } from '@openbot/core'
import type { DaemonError, StartScreenRequest } from './protocol.ts'

/** The screen daemon couldn't be reached or refused a request. */
export class ScreenDaemonError extends Error {}

/** The screens of the real computer, kept by the screen daemon listening on `socketPath`. */
export function connectScreens({ socketPath, timeout = 10_000 }: { socketPath: string; timeout?: number }): Screens {
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

  return {
    start: (bot: ScreenBot) => call<ScreenStatus>('PUT', path(bot), { display: bot.display } satisfies StartScreenRequest),
    stop: async (bot) => {
      await call<void>('DELETE', path(bot))
    },
    status: (bot) => call<ScreenStatus>('GET', path(bot)),
    list: () => call<ScreenListing[]>('GET', '/screens'),
  }
}
