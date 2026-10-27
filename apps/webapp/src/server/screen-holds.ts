/** How long a hold lasts unless renewed: the pane renews it while the owner has the screen, so a closed tab lets go. */
export const holdTtlMs = 60_000

type Hold = { timer: ReturnType<typeof setTimeout>; expiresAt: number; released: Promise<void>; release: () => void }

/**
 * Which bots' screens the owner holds (has taken over), kept in the server's memory. Computer-use sessions wait while a
 * screen is held, so their input never fights the owner's. A hold ends when the owner hands the screen back, or when
 * it isn't renewed for `holdTtlMs`.
 */
export class ScreenHolds {
  readonly #holds = new Map<string, Hold>()
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
    this.#holds.set(botId, { timer: this.#expire(botId), expiresAt, released, release })
    return { expiresAt }
  }

  /** Hands the bot's screen back; sessions waiting for it go on. */
  release(botId: string): void {
    const held = this.#holds.get(botId)
    if (!held) return
    clearTimeout(held.timer)
    this.#holds.delete(botId)
    held.release()
  }

  isHeld(botId: string): boolean {
    return this.#holds.has(botId)
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
