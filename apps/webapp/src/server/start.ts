// The production server: what a release's `bin/start` runs with plain Node (`node apps/webapp/src/server/start.ts`).
// It serves the built web app (`vite build`'s dist/) on the one port: static files from dist/client, everything else
// through TanStack Start's server build, and screens' live streams as WebSocket upgrades, in the same process as the
// API since stream tickets live in memory. In dev, Vite does all of this (see vite.config.ts).
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serve } from 'srvx'
import { staticMiddleware } from 'srvx/static'
import { handleScreenUpgrade, serverScreenTickets } from './screen-stream.ts'

type ServerBuild = { fetch(request: Request): Response | Promise<Response> }

export async function startServer({
  dist,
  hostname,
  port,
  gracefulShutdown = false,
}: {
  dist: string
  hostname: string
  port: number
  /** Let requests in flight finish on SIGTERM/SIGINT (how supervisord stops the server) before exiting. */
  gracefulShutdown?: boolean
}) {
  const build = (await import(pathToFileURL(join(dist, 'server', 'server.js')).href)) as { default: ServerBuild }
  const server = serve({
    hostname,
    port,
    silent: true,
    gracefulShutdown,
    middleware: [staticMiddleware({ dir: join(dist, 'client') })],
    fetch: (request) => build.default.fetch(request),
  })
  // Nothing else on this port takes upgrades.
  const http = server.node!.server!
  http.on('upgrade', (req, socket, head) => {
    if (!handleScreenUpgrade(serverScreenTickets(), req, socket, head)) socket.destroy()
  })
  await server.ready()
  return { url: server.url!, close: () => server.close(true) }
}

if (import.meta.main) {
  const port = Number(process.env.OPENBOT_PORT || 3000)
  // As in dev: localhost unless told otherwise; the runtime image sets 0.0.0.0.
  const hostname = process.env.OPENBOT_HOST || 'localhost'
  const dist = join(import.meta.dirname, '..', '..', 'dist')
  const { url } = await startServer({ dist, hostname, port, gracefulShutdown: true })
  console.log(`OpenBot ${process.env.OPENBOT_VERSION || 'dev'} listening on ${url}`)
}
