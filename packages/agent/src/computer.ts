import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { type ExecutionEnv, getOrThrow } from '@earendil-works/pi-durable/env'
import { Connection, localDaemon, RemoteExecutionEnv } from '@earendil-works/pi-env'
import { type ComputerBot, maxAttachmentBytes, safeFileName } from '@openbot/core'

const context = BACKGROUND_CONTEXT

/** Who the server's own file operations run for, such as saving the owner's files in a group chat's folder. */
const serverWork: ComputerBot = { id: 'openbot', name: 'OpenBot' }

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
  /** Why bots can't run on this computer, e.g. the server isn't in the runtime image; every environment refuses. */
  unavailable?: string
}

/** Bots can't run on this computer: the server isn't in the runtime image. */
export class ComputerUnavailableError extends Error {}

/**
 * Where bots work on the computer: each bot's shell and file tools run in an environment that starts in its own folder,
 * `<home>/bots/<id>`, and reaches the whole computer, the shared folder and other bots' folders included.
 */
export class BotComputer {
  readonly home: string
  readonly user: string
  /** Why bots can't run on this computer, if they can't. */
  readonly unavailable: string | undefined
  readonly #options: BotComputerOptions
  /** Each folder's latest upload; the next waits for it, so two uploads can't both take a free name. */
  readonly #uploads = new Map<string, Promise<unknown>>()

  constructor(options: BotComputerOptions) {
    this.home = options.home
    this.user = options.user
    this.unavailable = options.unavailable
    this.#options = options
  }

  /** Refuses any work on a computer bots can't run on. */
  #assertAvailable(): void {
    if (this.unavailable) throw new ComputerUnavailableError(this.unavailable)
  }

  /** The folder every bot can use. */
  get sharedFolder(): string {
    return join(this.home, 'shared')
  }

  /** A bot's own folder, where its commands start. */
  folder(botId: string): string {
    return join(this.home, 'bots', botId)
  }

  /** Where the files the owner sends a bot are saved. */
  uploadsFolder(botId: string): string {
    return join(this.folder(botId), 'uploads')
  }

  /** Where the files the owner sends a group chat are saved: in the shared folder, so every member reads them. */
  groupFolder(chatId: string): string {
    return join(this.sharedFolder, 'groups', chatId)
  }

  /**
   * Saves a file the owner sent `bot` to its uploads folder, as the bots' user; returns its path there. A name already
   * taken gets a number, `notes-2.txt`, so an earlier upload is never overwritten.
   */
  async saveUpload(bot: ComputerBot, name: string, bytes: Uint8Array): Promise<string> {
    return this.#saveIn(await this.env(bot), this.uploadsFolder(bot.id), name, bytes)
  }

  /** Saves a file the owner sent group chat `chatId` to its folder, as `saveUpload` does; returns its path there. */
  saveGroupUpload(chatId: string, name: string, bytes: Uint8Array): Promise<string> {
    return this.#saveIn(this.#serverEnv(), this.groupFolder(chatId), name, bytes)
  }

  /** Deletes a deleted group chat's folder and the owner's files in it. */
  async removeGroupFolder(chatId: string): Promise<void> {
    getOrThrow(await this.#serverEnv().remove(this.groupFolder(chatId), { recursive: true, force: true }, context))
  }

  /** Saves a file in `folder` under a free name; uploads to one folder go one at a time, so two can't take one name. */
  #saveIn(env: ExecutionEnv, folder: string, name: string, bytes: Uint8Array): Promise<string> {
    const saved = (this.#uploads.get(folder) ?? Promise.resolve()).catch(() => {}).then(() => this.#save(env, folder, name, bytes))
    this.#uploads.set(folder, saved)
    void saved.finally(() => this.#uploads.get(folder) === saved && this.#uploads.delete(folder)).catch(() => {})
    return saved
  }

  async #save(env: ExecutionEnv, folder: string, name: string, bytes: Uint8Array): Promise<string> {
    getOrThrow(await env.createDir(folder, { recursive: true }, context))
    const safe = safeFileName(name)
    const ext = extname(safe)
    const stem = safe.slice(0, safe.length - ext.length)
    let path = join(folder, safe)
    for (let n = 2; getOrThrow(await env.exists(path, context)); n++) path = join(folder, `${stem}-${n}${ext}`)
    getOrThrow(await env.writeFile(path, bytes, context))
    return path
  }

  /** An environment for the server's own work on the bots' files, as the bots' user but for no one bot. */
  #serverEnv(): ExecutionEnv {
    this.#assertAvailable()
    return this.#options.env(serverWork, this.home)
  }

  /**
   * Reads a file `bot` names, as the bots' user: an absolute path, or one relative to the bot's folder. Throws when it
   * isn't a file or is larger than an attachment may be.
   */
  async readFile(bot: ComputerBot, path: string): Promise<{ path: string; bytes: Uint8Array }> {
    const env = await this.env(bot)
    const absolute = isAbsolute(path) ? path : resolve(this.folder(bot.id), path)
    const info = getOrThrow(await env.fileInfo(absolute, context))
    if (info.kind === 'directory') throw new Error(`${path} is not a file`)
    if (info.size > maxAttachmentBytes) throw new Error(`${path} is larger than ${maxAttachmentBytes / 1024 / 1024} MB`)
    return { path: absolute, bytes: getOrThrow(await env.readBinaryFile(absolute, context)) }
  }

  /** Writes a file for `bot` as the bots' user, at a path relative to its folder, making the folders on the way. */
  async writeFile(bot: ComputerBot, path: string, bytes: Uint8Array): Promise<string> {
    const env = await this.env(bot)
    const absolute = resolve(this.folder(bot.id), path)
    getOrThrow(await env.createDir(dirname(absolute), { recursive: true }, context))
    getOrThrow(await env.writeFile(absolute, bytes, context))
    return absolute
  }

  /** The environment `bot`'s tools run in, once its folder exists; made again if the bot deleted it. */
  async env(bot: ComputerBot): Promise<ExecutionEnv> {
    this.#assertAvailable()
    const folder = this.folder(bot.id)
    const env = this.#options.env(bot, folder)
    getOrThrow(await env.createDir(folder, { recursive: true }, context))
    return env
  }

  /** Deletes a deleted bot's folder and everything in it. */
  async removeFolder(bot: ComputerBot): Promise<void> {
    this.#assertAvailable()
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
 * The real computer: one pi-env daemon, started as the bots' user `user` (through sudo when the server runs as another
 * user, as `openbot-server` does in the runtime image), runs every bot's commands and file operations. Only the runtime
 * image is supported: outside it (no such user, or no daemon for this machine) bots refuse to run, rather than running
 * commands as the server's user while their prompt says otherwise.
 */
export function openBotComputer({ home, user = botUser }: { home: string; user?: string }): BotComputer {
  const daemon = packagedDaemon()
  if (!userExists(user) || !daemon) {
    const missing = !userExists(user) ? `there is no ${user} user` : 'there is no pi-env daemon for this machine'
    const unavailable = `Bots run only in OpenBot's runtime image, and this server isn't in it: ${missing}. Start OpenBot with Docker Compose (\`pnpm dev:up\` for development).`
    console.error(`[computer] ${unavailable}`)
    return new BotComputer({
      home,
      user,
      // Never reached: every use refuses first.
      env: () => {
        throw new ComputerUnavailableError(unavailable)
      },
      unavailable,
    })
  }
  // `--set-home` so commands see the bots' home as ~, not the server's.
  const command = userInfo().username === user ? [daemon] : ['sudo', '--non-interactive', '--set-home', `--user=${user}`, '--', daemon]
  const connection = new Connection({ command, onLog: (text) => console.error(`[pi-env] ${text.trimEnd()}`) })
  return new BotComputer({
    home,
    user,
    // One computer: every environment sees the same files.
    env: (_bot, cwd) => new RemoteExecutionEnv({ connection, id: 'openbot:computer', cwd }),
    close: () => connection.close(),
  })
}

/** The pi-env daemon this package ships for this machine, if there is one. */
function packagedDaemon(): string | undefined {
  try {
    const daemon = localDaemon()
    return existsSync(daemon) ? daemon : undefined
  } catch {
    return undefined
  }
}
