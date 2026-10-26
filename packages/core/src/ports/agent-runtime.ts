/** Priority class of a bot's pending work, highest first. */
export const lanes = ['owner', 'bot', 'background'] as const
export type Lane = (typeof lanes)[number]

/** Something that wakes a bot: one entry in its history, tagged with where it came from. */
export type BotInput = {
  lane: Lane
  text: string
  /** Makes waking again with the same id a no-op, e.g. the id of the message that woke the bot. */
  id?: string
}

/** Runs bots' models and tools. Implemented on pi-durable by `@openbot/agent` (ADR 0005). */
export interface AgentRuntime {
  /** Queues `input` for the bot; returns once queued, not when the run ends. */
  wake(botId: string, input: BotInput): Promise<void>
  /** Aborts the bot's current run. */
  stop(botId: string): Promise<void>
}
