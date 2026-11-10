import { maxReplyPreviewLength, type MessageInfo, previewText, type ReactionInfo, type ReplyToInfo } from '@openbot/api-contract'

/** The reactor the owner's reactions are by. */
export const ownerReactor = 'owner'

/** One emoji's pill under a message: how many left it, whether the owner did, and who, in the order they did. */
export type ReactionPill = { emoji: string; count: number; mine: boolean; by: string[] }

/** A message's reactions as pills, one per emoji, in the order each was first left. */
export function reactionPills(reactions: readonly ReactionInfo[]): ReactionPill[] {
  const pills = new Map<string, ReactionPill>()
  for (const { emoji, by } of reactions) {
    const pill = pills.get(emoji) ?? { emoji, count: 0, mine: false, by: [] }
    pills.set(emoji, { ...pill, count: pill.count + 1, mine: pill.mine || by === ownerReactor, by: [...pill.by, by] })
  }
  return [...pills.values()]
}

/** Who left a pill, for its label: "You, Rex", the owner first, a bot that's gone as "Deleted bot". */
export function reactorNames({ by }: Pick<ReactionPill, 'by'>, bots: readonly { id: string; name: string }[]): string {
  const names = [...by].sort((a, b) => Number(b === ownerReactor) - Number(a === ownerReactor))
  return names.map((id) => (id === ownerReactor ? 'You' : (bots.find((bot) => bot.id === id)?.name ?? 'Deleted bot'))).join(', ')
}

/**
 * What the owner's reply quotes of `message`, as the composer's reply pill and the sent bubble show it until the server
 * returns its own: its text on one line without Markdown, or its files' names.
 */
export function replyTargetOf(message: MessageInfo): ReplyToInfo {
  const text = previewText(message.text) || message.attachments.map((file) => file.name).join(', ')
  return { id: message.id, author: message.author, botId: message.botId, authorName: message.authorName, text: text.slice(0, maxReplyPreviewLength) }
}

/** A reply's quote as it shows on one line: its text without Markdown, or "Message" when it has none. */
export const quotedText = (reply: Pick<ReplyToInfo, 'text'>) => previewText(reply.text) || 'Message'
