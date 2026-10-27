/** How long a hold lasts unless renewed: the pane renews it while the owner has the screen, so a closed tab lets go. */
export const holdTtlMs = 60_000

type Hold = { timer: ReturnType<typeof setTimeout>; since: number; expiresAt: number; released: Promise<void>; release: () => void }

/**
 * Which bots' screens the owner holds (has taken over), kept in the server's memory. Computer-use sessions wait while a
 * screen is held, so their input never fights the owner's. A hold ends when the owner hands the screen back, or when
 * it isn't renewed for `holdTtlMs`.
 */
export class ScreenHolds {
  readonly #holds = new Map<string, Hold>()
  /** How long each bot's screen was held, holds that ended only. */
  readonly #heldMs = new Map<string, number>()
  readonly #ttlMs: number

  constructor(ttlMs = holdTtlMs) {
    this.#ttlMs = ttlMs
  }

  /** Holds the bot's screen, or renews the hold; returns when it ends unless renewed. */
  hold(botId: string): { expiresAt: number } {
    const expiresAt = Date.now() + this.#ttlMs
    const held = this.#holds.get(botId)
    if (held) {
      clearTimeout(held.timer)
      held.timer = this.#expire(botId)
      held.expiresAt = expiresAt
      return { expiresAt }
    }
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    this.#holds.set(botId, { timer: this.#expire(botId), since: Date.now(), expiresAt, released, release })
    return { expiresAt }
  }

  /** Hands the bot's screen back; sessions waiting for it go on. Returns whether it was held. */
  release(botId: string): boolean {
    const held = this.#holds.get(botId)
    if (!held) return false
    clearTimeout(held.timer)
    this.#holds.delete(botId)
    this.#heldMs.set(botId, (this.#heldMs.get(botId) ?? 0) + Date.now() - held.since)
    held.release()
    return true
  }

  isHeld(botId: string): boolean {
    return this.#holds.has(botId)
  }

  /** How long the bot's screen has been held in all, a hold still on included: time its sessions spent waiting. */
  heldMs(botId: string): number {
    const held = this.#holds.get(botId)
    return (this.#heldMs.get(botId) ?? 0) + (held ? Date.now() - held.since : 0)
  }

  /** Resolves once the bot's screen isn't held: at once when it isn't. */
  async whenFree(botId: string): Promise<void> {
    let held
    while ((held = this.#holds.get(botId))) await held.released
  }

  #expire(botId: string) {
    const timer = setTimeout(() => this.release(botId), this.#ttlMs)
    timer.unref?.()
    return timer
  }
}
