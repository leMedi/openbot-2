import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import type { Server as HttpServer } from 'node:http'
import { defineConfig, type Plugin, type PreviewOptions } from 'vite'
import { z } from 'zod'
import { handleScreenUpgrade, serverScreenTickets } from './src/server/screen-stream.ts'

// The one port (OPENBOT_PORT) and listen address (OPENBOT_HOST; 0.0.0.0 in the container). Requests for the public URL's
// host are allowed too, e.g. a host name.
const env = z
  .object({
    OPENBOT_HOST: z.string().optional(),
    OPENBOT_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    OPENBOT_PUBLIC_URL: z.url().optional(),
  })
  .parse(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== '')))

const server: PreviewOptions = {
  host: env.OPENBOT_HOST,
  port: env.OPENBOT_PORT,
  strictPort: true,
  allowedHosts: env.OPENBOT_PUBLIC_URL ? [new URL(env.OPENBOT_PUBLIC_URL).hostname] : undefined,
}

/**
 * Screens' live streams on the one port: WebSocket upgrades at /api/screens/:botId/stream are bridged to the screen on
 * a ticket the API issued (in this same process). Other upgrades, like Vite's hot reload, are left alone.
 */
function screenStreams(): Plugin {
  // In dev, other upgrades are Vite's hot reload; in preview nothing else takes them, so they're closed.
  const attach = (http: HttpServer | null | undefined, closeOthers: boolean) => {
    http?.on('upgrade', (req, socket, head) => {
      if (!handleScreenUpgrade(serverScreenTickets(), req, socket, head) && closeOthers) socket.destroy()
    })
  }
  return {
    name: 'openbot-screen-streams',
    configureServer: (dev) => attach(dev.httpServer as HttpServer | null, false),
    configurePreviewServer: (preview) => attach(preview.httpServer as HttpServer, true),
  }
}

export default defineConfig({
  plugins: [screenStreams(), tailwindcss(), tanstackStart(), viteReact()],
  server,
  preview: server,
})
