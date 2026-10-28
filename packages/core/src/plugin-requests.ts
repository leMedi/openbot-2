import { type Db, type Message, messages } from '@openbot/db'
import { and, eq, isNull } from 'drizzle-orm'
import { getMessage } from './chats.ts'
import { oweReply } from './owed-replies.ts'

/**
 * A plugin request card's payload, as stored in `messages.card`: a bot asks the owner for a plugin (design §5.5). The
 * owner connects a new account and grants it, picks a connected one to grant, or denies.
 */
export type PluginRequestCard = {
  type: 'plugin_request'
  /** The plugin's catalog name. */
  plugin: string
  /** Its display name when asked, e.g. Notion. */
  displayName: string
  /** Why the bot asks, in its words. */
  reason: string
  /** A plugin of skills only, granted without an account. */
  skillsOnly: boolean
}

/**
 * How the owner decided, as stored in `messages.card_state`; absent while the card waits. A grant names the account
 * granted, as it was named then, or none for a plugin of skills only.
 */
export type PluginRequestDecision = { outcome: 'granted'; account: { slug: string; displayName: string } | null } | { outcome: 'denied' }

export class PluginRequestNotFoundError extends Error {}
export class PluginRequestDecidedError extends Error {}

export function isPluginRequestCard(card: unknown): card is PluginRequestCard {
  return typeof card === 'object' && card !== null && (card as { type?: unknown }).type === 'plugin_request'
}

/** How the owner decided, or null while the card waits. */
export function pluginRequestDecisionOf(message: Pick<Message, 'cardState'>): PluginRequestDecision | null {
  return (message.cardState as PluginRequestDecision | null) ?? null
}

/** What the card's message says, e.g. in the sidebar while it waits: "Wants to use Notion: <reason>". */
export const describePluginRequest = (card: PluginRequestCard) => `Wants to use ${card.displayName}: ${card.reason}`

/**
 * The plugin request card `messageId`, while it waits for the owner. Throws `PluginRequestNotFoundError` when the
 * message is no such card and `PluginRequestDecidedError` once it is decided.
 */
export async function waitingPluginRequest(db: Db, messageId: string): Promise<Message & { card: PluginRequestCard }> {
  const message = await getMessage(db, messageId)
  if (!message || !isPluginRequestCard(message.card)) throw new PluginRequestNotFoundError('No such plugin request')
  if (message.cardState) throw new PluginRequestDecidedError('The request was already decided')
  return message as Message & { card: PluginRequestCard }
}

/**
 * Records the owner's decision on a plugin request card, once: of two racing, only the first is kept. Throws as
 * `waitingPluginRequest` does.
 */
export async function decidePluginRequest(db: Db, messageId: string, decision: PluginRequestDecision): Promise<{ message: Message; card: PluginRequestCard }> {
  const { card } = await waitingPluginRequest(db, messageId)
  // The bot owes the owner a reply once it has gone on, as to their message.
  const decided = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ cardState: decision })
      .where(and(eq(messages.id, messageId), isNull(messages.cardState)))
      .returning()
    if (row) await oweReply(tx, row.chatId)
    return row
  })
  if (!decided) throw new PluginRequestDecidedError('The request was already decided')
  return { message: decided, card }
}

/** Takes back a decision that never reached the bot, so the owner can decide again. */
export async function reopenPluginRequest(db: Db, messageId: string): Promise<Message | undefined> {
  const [reopened] = await db.update(messages).set({ cardState: null }).where(eq(messages.id, messageId)).returning()
  return reopened
}

/** How a decision reaches the bot that asked: the next input of its history. */
export function describePluginDecision(card: PluginRequestCard, decision: PluginRequestDecision, toolPrefix?: string): string {
  const asked = `your request for ${card.displayName} ("${card.reason}")`
  if (decision.outcome === 'denied') {
    return (
      `The owner denied ${asked}. Don't ask for it again now: go on without it if you can, another way, or send the ` +
      'owner a brief message saying what is blocked.'
    )
  }
  if (!decision.account) {
    return `The owner granted you ${card.displayName} after ${asked}. Its skills are listed in your instructions from your next compaction.`
  }
  const tools = toolPrefix ? ` Its tools are named ${toolPrefix}…: load them with tool_search, then go on.` : ''
  return `The owner granted you ${card.displayName} (${decision.account.displayName}) after ${asked}.${tools}`
}
