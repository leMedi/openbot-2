import { viewingHeartbeatInterval } from '@openbot/api-contract'
import type { Clock } from '@openbot/core'

/**
 * How long a viewing heartbeat stays fresh: one and a half heartbeat intervals, so a late heartbeat doesn't let a push
 * through while the owner reads, and a client that stopped sending (the tab lost focus, the app went to the background)
 * soon stops counting.
 */
export const viewingFreshFor = (viewingHeartbeatInterval * 3) / 2

/**
 * Which chats the owner is viewing, from the clients' heartbeats on the server's clock, for the push sender to skip.
 * Kept in memory: after a restart, the next heartbeats say it again.
 */
export class ViewedChats {
  readonly #clock: Clock
  /** When each chat's latest heartbeat came, from any client. */
  readonly #heard = new Map<string, number>()

  constructor(clock: Clock) {
    this.#clock = clock
  }

  /** A client says the owner is viewing the chat now. */
  heartbeat(chatId: string) {
    const now = this.#clock.now()
    for (const [id, at] of this.#heard) if (at + viewingFreshFor <= now) this.#heard.delete(id)
    this.#heard.set(chatId, now)
  }

  /** Whether the owner is viewing the chat: a client's heartbeat for it is still fresh. */
  isViewed(chatId: string): boolean {
    const at = this.#heard.get(chatId)
    return at !== undefined && this.#clock.now() < at + viewingFreshFor
  }
}
