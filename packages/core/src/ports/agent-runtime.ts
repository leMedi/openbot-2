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
  /**
   * Bot lane only: goes ahead of the bot's other bot- and background-lane work and interrupts a bot- or background-lane
   * run, which runs again after it. A run for the owner is never interrupted by it.
   */
  priority?: boolean
  /**
   * Owner lane only: the input is the bot's turn in this group chat. It waits for the bot's current run. The owner's DM
   * message interrupts it like any run, and the turn is retried after it, up to 3 runs. What the bot sends with
   * `sendMessage` in it goes to the group; it may pass, sending nothing.
   */
  groupChatId?: string
}

/** Runs bots' models and tools. Implemented on pi-durable by `@openbot/agent` (ADR 0005). */
export interface AgentRuntime {
  /**
   * Queues `input` for the bot; returns once queued, not when the run ends. The owner's DM message supersedes the run
   * going on (Grok's model: there is no Stop); anything else waits for it, then runs in lane order (owner, bot,
   * background), oldest first within a lane. Queued work is never dropped (a group turn interrupted on its third run
   * ends there).
   */
  wake(botId: string, input: BotInput): Promise<void>
  /**
   * Queues `input` as `wake` does and resolves once its run has ended for good, or it was dropped (the bot deleted, the
   * runtime closed). A group chat's rounds wait on each member's turn with it.
   */
  takeTurn(botId: string, input: BotInput): Promise<void>
  /** Aborts a deleted bot's run and drops everything the runtime holds for it, its folder on the computer included. */
  forget(bot: { id: string; name: string; historyId: string | null }): Promise<void>
}
