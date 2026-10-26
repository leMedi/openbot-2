import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so tests don't boot TanStack Start.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
