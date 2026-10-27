import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { builtinModelProviders, openBotComputer } from '@openbot/agent'
import { connectScreens } from '@openbot/computer'
import { openDb } from '@openbot/db'
import { env, paths } from '@openbot/db/env'
import { createServerContext, type ServerContext } from './context.ts'
import { serverScreenTickets } from './screen-stream.ts'

/** `OPENBOT_SECRET_KEY`, or the key generated into the data dir on first boot. */
async function loadSecretKey(): Promise<string> {
  if (env.OPENBOT_SECRET_KEY) return env.OPENBOT_SECRET_KEY
  try {
    return (await readFile(paths.secretKey, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const key = randomBytes(32).toString('base64url')
    await mkdir(dirname(paths.secretKey), { recursive: true })
    try {
      // `wx` so two boots racing can't each write a different key; the loser reads the winner's.
      await writeFile(paths.secretKey, `${key}\n`, { mode: 0o600, flag: 'wx' })
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return (await readFile(paths.secretKey, 'utf8')).trim()
    }
  }
}

async function open(): Promise<ServerContext> {
  const [db, secretKey, providers] = await Promise.all([openDb(paths.database), loadSecretKey(), builtinModelProviders()])
  return createServerContext({
    db,
    secretKey,
    providers,
    agentStoragePath: join(paths.dataDir, 'agent.sqlite'),
    computer: openBotComputer({ home: paths.home }),
    attachmentsDir: join(paths.dataDir, 'attachments'),
    screens: connectScreens({ socketPath: paths.desktopdSocket }),
    screenTickets: serverScreenTickets(),
  })
}

let context: Promise<ServerContext> | undefined

/** The server's one context, opened (and migrated) on the first request. */
export function getServerContext(): Promise<ServerContext> {
  context ??= open().catch((error) => {
    context = undefined // let the next request retry
    throw error
  })
  return context
}
