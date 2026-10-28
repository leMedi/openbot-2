import type { FactTier, RoutineRunInfo } from '@openbot/api-contract'

/**
 * A message in a chat: the owner's, a bot's to the owner, one bot's to another (copied into both DMs), or a timeline
 * row about a bot, such as its change to a routine, which says nothing to the owner.
 */
export type ChatMessage = { from: 'owner' | 'bot' | 'between_bots' | 'timeline'; author: string; text: string }

/** A run's record: everything it left behind that assertions and the judge look at. */
export type RunRecord = {
  /** Every bot's tool calls, in the order each made them; bots' calls interleave by bot, not by time. */
  toolCalls: { bot: string; tool: string; args: unknown }[]
  /** Each chat's messages, oldest first, by chat name: a bot's name for its DM, a group's for a group chat. */
  chats: Record<string, ChatMessage[]>
  /**
   * Every fact in memory at the end, as the owner sees them: `in` shared memory or a bot's (its name), and `source`,
   * the owner or the name of the bot that wrote it.
   */
  memory: Fact[]
  /** Every bot's routines at the end, oldest first by bot. */
  routines: RoutineRecord[]
}

/** A fact in memory at the end of a run. */
export type Fact = { in: string; tier: FactTier; text: string; source: string }

/**
 * A routine at the end of a run: `by` the owner or the bot (whoever created or last edited it), whether it is on (a
 * reminder that fired is off), and its runs, oldest first: each one's status and whether it messaged the owner.
 */
export type RoutineRecord = {
  bot: string
  name: string
  prompt: string
  schedule: string
  enabled: boolean
  by: 'owner' | 'bot'
  runs: { status: RoutineRunInfo['status']; messaged: boolean }[]
}
