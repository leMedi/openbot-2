/** What a bot's message in a chat was: for the owner, or one bot's message to another (copied into both DMs). */
export type ChatMessage = { from: 'owner' | 'bot' | 'between_bots'; author: string; text: string }

/** A run's record: everything it left behind that assertions and the judge look at. */
export type RunRecord = {
  /** Every bot's tool calls, in the order each made them; bots' calls interleave by bot, not by time. */
  toolCalls: { bot: string; tool: string; args: unknown }[]
  /** Each chat's messages, oldest first, by chat name: a bot's name for its DM, a group's for a group chat. */
  chats: Record<string, ChatMessage[]>
}
