import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type PreviewOptions } from 'vite'
import { z } from 'zod'

// The one port (OPENBOT_PORT) and listen address (OPENBOT_HOST; 0.0.0.0 in the container). Requests for the public URL's
// host are allowed too, e.g. a tailnet name.
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

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  server,
  preview: server,
})
