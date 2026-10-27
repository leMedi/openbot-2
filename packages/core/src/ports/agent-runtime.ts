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
   * Bot lane only: goes ahead of the bot's other queued work and interrupts a bot- or background-lane run, which is
   * redelivered once. An owner run is never interrupted.
   */
  priority?: boolean
  /**
   * Owner lane only: the input is the bot's turn in this group chat. A turn neither steers a run nor is steered by the
   * owner's DM: it waits for the bot's current run, and the owner's DM input waits for it. What the bot sends with
   * `sendMessage` in it goes to the group; it may pass, sending nothing.
   */
  groupChatId?: string
}

/** Runs bots' models and tools. Implemented on pi-durable by `@openbot/agent` (ADR 0005). */
export interface AgentRuntime {
  /**
   * Queues `input` for the bot; returns once queued, not when the run ends. An owner input steers a run that is going;
   * anything else waits for it, then runs in lane order (owner, bot, background), oldest first within a lane.
   */
  wake(botId: string, input: BotInput): Promise<void>
  /**
   * Queues `input` as `wake` does and resolves once its run has ended, or it was dropped (Stop, the bot deleted, the
   * runtime closed). A group chat's rounds wait on each member's turn with it.
   */
  takeTurn(botId: string, input: BotInput): Promise<void>
  /** Aborts the bot's current run and drops the work queued behind it. */
  stop(botId: string): Promise<void>
  /** Aborts a deleted bot's run and drops everything the runtime holds for it, its folder on the computer included. */
  forget(bot: { id: string; name: string; historyId: string | null }): Promise<void>
}
