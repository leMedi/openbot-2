import type { BotInfo } from '@openbot/api-contract'

/** What a bot's avatar is drawn from. */
export type CachedBot = Pick<BotInfo, 'id' | 'avatarStyle' | 'avatarShape' | 'avatarColor'>

/** Each cached bot's drawing key (`avatarKey`), by its id. */
export type AvatarManifest = Record<string, string>

/** The avatars folder in the app group, which the iOS Notification Service Extension reads (`<botId>.png`). */
export type AvatarFiles = {
  readManifest(): AvatarManifest | undefined
  writeManifest(manifest: AvatarManifest): void
  /** Writes a bot's avatar, a PNG given as base64. */
  writeAvatar(botId: string, png: string): void
  removeAvatar(botId: string): void
  /** Removes every avatar and the manifest. */
  clear(): void
}

/**
 * What a bot's drawing depends on. The version is bumped when the drawing itself changes (the size, @openbot/ui's
 * avatars), so the next sync draws every bot again.
 */
const drawingVersion = 2
export const avatarKey = (bot: CachedBot) => `${drawingVersion}:${bot.avatarStyle}:${bot.avatarShape}:${bot.avatarColor}`

/**
 * The bots' avatars kept on the phone for its notifications (spec: Notifications on the phone → Avatar): a push never
 * downloads one, the extension draws the notification from what's here, offline included. `sync` follows the bots as
 * they change, drawing (with `render`, a PNG as base64) only a bot whose avatar is new or changed, and removing a gone
 * bot's; syncs run one at a time and settle on the latest bots. A bot that couldn't be drawn is tried at the next sync.
 */
export class AvatarCache {
  readonly #files: AvatarFiles
  readonly #render: (bot: CachedBot) => Promise<string>
  #latest: readonly CachedBot[] | undefined
  /** Bumped by each sync and by clear, so a sync that's no longer the latest stops. */
  #generation = 0
  #queue: Promise<void> = Promise.resolve()

  constructor({ files, render }: { files: AvatarFiles; render: (bot: CachedBot) => Promise<string> }) {
    this.#files = files
    this.#render = render
  }

  /** Brings the cache to `bots`; settles once it has (or a later sync or clear took over). */
  sync(bots: readonly CachedBot[]): Promise<void> {
    this.#latest = bots
    const generation = ++this.#generation
    this.#queue = this.#queue.then(() => this.#sync(generation)).catch((error) => console.warn("[avatars] Couldn't keep the bots' avatars:", error))
    return this.#queue
  }

  /** Removes every avatar, as the phone leaves the instance; a sync under way stops. */
  clear() {
    this.#latest = undefined
    this.#generation++
    try {
      this.#files.clear()
    } catch (error) {
      console.warn("[avatars] Couldn't remove the bots' avatars:", error)
    }
  }

  async #sync(generation: number) {
    const bots = this.#latest
    if (!bots || generation !== this.#generation) return
    const manifest: AvatarManifest = { ...this.#files.readManifest() }
    const ids = new Set(bots.map((bot) => bot.id))
    const gone = Object.keys(manifest).filter((id) => !ids.has(id))
    for (const id of gone) {
      this.#files.removeAvatar(id)
      delete manifest[id]
    }
    if (gone.length) this.#files.writeManifest(manifest)
    for (const bot of bots) {
      const key = avatarKey(bot)
      if (manifest[bot.id] === key) continue
      let png: string
      try {
        png = await this.#render(bot)
      } catch {
        continue
      }
      if (generation !== this.#generation) return
      this.#files.writeAvatar(bot.id, png)
      manifest[bot.id] = key
      this.#files.writeManifest(manifest)
    }
  }
}
