import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

// Scripts run from each package's folder, so relative paths are anchored to the repo root instead of the cwd.
function findRepoRoot(from = process.cwd()): string {
  let dir = resolve(from)
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`)
    dir = parent
  }
  return dir
}

export const env = createEnv({
  server: {
    OPENBOT_DATA_DIR: z
      .string()
      .min(1)
      .transform((path) => resolve(findRepoRoot(), path)),
    /** The bots' home: `shared/`, `bots/<id>/`. */
    OPENBOT_HOME: z
      .string()
      .min(1)
      .default('/home/openbot')
      .transform((path) => resolve(findRepoRoot(), path)),
    /** The screen daemon's Unix socket. */
    OPENBOT_DESKTOPD_SOCKET: z.string().min(1).default('/run/openbot/desktopd.sock'),
    /** Encrypts system credentials; when unset, one is generated into the data dir on first boot. */
    OPENBOT_SECRET_KEY: z.string().min(32).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})

export const paths = {
  dataDir: env.OPENBOT_DATA_DIR,
  database: join(env.OPENBOT_DATA_DIR, 'openbot.db'),
  secretKey: join(env.OPENBOT_DATA_DIR, 'secret.key'),
  home: env.OPENBOT_HOME,
  desktopdSocket: env.OPENBOT_DESKTOPD_SOCKET,
}
