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

/** Whether the owner left `emoji` on a message. */
export const ownerReacted = ({ reactions }: { reactions: readonly ReactionInfo[] }, emoji: string) =>
  reactions.some((reaction) => reaction.emoji === emoji && reaction.by === ownerReactor)

/** Who left a pill, for its label: "You, Rex", the owner first, a bot that's gone as "Deleted bot". */
export function reactorNames({ by }: Pick<ReactionPill, 'by'>, bots: readonly { id: string; name: string }[]): string {
  const names = [...by].sort((a, b) => Number(b === ownerReactor) - Number(a === ownerReactor))
  return names.map((id) => (id === ownerReactor ? 'You' : (bots.find((bot) => bot.id === id)?.name ?? 'Deleted bot'))).join(', ')
}

/**
 * What the owner's reply quotes of `message`, as the composer's reply pill and the sent bubble show it until the server
 * returns its own, cut as the server cuts it: its text on one line, or its files' names.
 */
export function replyTargetOf(message: MessageInfo): ReplyToInfo {
  const line = (message.text.trim() || message.attachments.map((file) => file.name).join(', ')).replace(/\s+/g, ' ').trim()
  const text = line.length > maxReplyPreviewLength ? `${line.slice(0, maxReplyPreviewLength)}…` : line
  return { id: message.id, author: message.author, botId: message.botId, authorName: message.authorName, text }
}

/** Who a reply quotes, as it shows: You for the owner. */
export const quotedAuthor = (reply: Pick<ReplyToInfo, 'author' | 'authorName'>) => (reply.author === 'owner' ? 'You' : reply.authorName)

/** A reply's quote as it shows on one line: its text without Markdown, or "Message" when it has none. */
export const quotedText = (reply: Pick<ReplyToInfo, 'text'>) => previewText(reply.text) || 'Message'
