import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { type ExecutionEnv, getOrThrow } from '@earendil-works/pi-durable/env'
import { Connection, localDaemon, RemoteExecutionEnv } from '@earendil-works/pi-env'
import type { ComputerBot } from '@openbot/core'

const context = BACKGROUND_CONTEXT

/** The bots' Unix user on the computer, with passwordless sudo (design §2.1). */
export const botUser = 'openbot'

export type BotComputerOptions = {
  /** The bots' home, `$OPENBOT_HOME`: `shared/` and `bots/<id>/`. */
  home: string
  /** The Unix user bots' commands run as. */
  user: string
  /** An environment for `bot`'s tools that starts in `cwd`. */
  env(bot: ComputerBot, cwd: string): ExecutionEnv
  /** Stops whatever runs the environments. */
  close?(): void | Promise<void>
}

/**
 * Where bots work on the computer: each bot's shell and file tools run in an environment that starts in its own folder,
 * `<home>/bots/<id>`, and reaches the whole computer, the shared folder and other bots' folders included.
 */
export class BotComputer {
  readonly home: string
  readonly user: string
  readonly #options: BotComputerOptions

  constructor(options: BotComputerOptions) {
    this.home = options.home
    this.user = options.user
    this.#options = options
  }

  /** The folder every bot can use. */
  get sharedFolder(): string {
    return join(this.home, 'shared')
  }

  /** A bot's own folder, where its commands start. */
  folder(botId: string): string {
    return join(this.home, 'bots', botId)
  }

  /** The environment `bot`'s tools run in, once its folder exists; made again if the bot deleted it. */
  async env(bot: ComputerBot): Promise<ExecutionEnv> {
    const folder = this.folder(bot.id)
    const env = this.#options.env(bot, folder)
    getOrThrow(await env.createDir(folder, { recursive: true }, context))
    return env
  }

  /** Deletes a deleted bot's folder and everything in it. */
  async removeFolder(bot: ComputerBot): Promise<void> {
    const env = this.#options.env(bot, this.home)
    getOrThrow(await env.remove(this.folder(bot.id), { recursive: true, force: true }, context))
  }

  async close(): Promise<void> {
    await this.#options.close?.()
  }
}

/** Whether `name` is a user on this machine. */
export function userExists(name: string): boolean {
  try {
    return readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .some((line) => line.startsWith(`${name}:`))
  } catch {
    return false
  }
}

/**
 * The real computer: one pi-env daemon, started as the bots' user (through sudo when the server runs as another user,
 * as `openbot-server` does in the runtime image), runs every bot's commands and file operations. Where that user doesn't
 * exist, e.g. running the server straight on a developer's machine, the daemon runs as the server's user.
 */
export function openBotComputer({ home }: { home: string }): BotComputer {
  const daemon = localDaemon()
  const serverUser = userInfo().username
  const asServer = serverUser === botUser || !userExists(botUser)
  if (asServer && serverUser !== botUser) console.warn(`[computer] There is no ${botUser} user, so bots' commands run as ${serverUser}`)
  // `--set-home` so commands see the bots' home as ~, not the server's.
  const command = asServer ? [daemon] : ['sudo', '--non-interactive', '--set-home', `--user=${botUser}`, '--', daemon]
  const connection = new Connection({ command, onLog: (text) => console.error(`[pi-env] ${text.trimEnd()}`) })
  return new BotComputer({
    home,
    user: asServer ? serverUser : botUser,
    // One computer: every environment sees the same files.
    env: (_bot, cwd) => new RemoteExecutionEnv({ connection, id: 'openbot:computer', cwd }),
    close: () => connection.close(),
  })
}
