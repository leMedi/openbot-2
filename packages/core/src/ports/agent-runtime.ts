import type { Attachment } from '@openbot/db'

/** Priority class of a bot's pending work, highest first. */
export const lanes = ['owner', 'bot', 'background'] as const
export type Lane = (typeof lanes)[number]

/** Something that wakes a bot: one entry in its history, tagged with where it came from. */
export type BotInput = {
  lane: Lane
  text: string
  /** Files that came with it, already on the computer; the bot is told where, and sees images. */
  attachments?: readonly Attachment[]
  /** Makes waking again with the same id a no-op, e.g. the id of the message that woke the bot. */
  id?: string
}

/** Runs bots' models and tools. Implemented on pi-durable by `@openbot/agent` (ADR 0005). */
export interface AgentRuntime {
  /** Queues `input` for the bot; returns once queued, not when the run ends. */
  wake(botId: string, input: BotInput): Promise<void>
  /** Aborts the bot's current run. */
  stop(botId: string): Promise<void>
  /** Aborts a deleted bot's run and drops everything the runtime holds for it, its folder on the computer included. */
  forget(bot: { id: string; name: string; historyId: string | null }): Promise<void>
}
