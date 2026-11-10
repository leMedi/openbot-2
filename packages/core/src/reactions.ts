import { type Db, type Message, type ReplyQuote, messages } from '@openbot/db'
import { and, desc, eq, inArray, like } from 'drizzle-orm'
import { isRoutineChangeCard } from './routines.ts'

/** There is no message with that id. */
export class MessageNotFoundError extends Error {}

/** What can't be left as a reaction: anything but one emoji. */
export class InvalidReactionError extends Error {}

/** The reactor a reaction of the owner's is by. */
export const ownerReactor = 'owner'

/**
 * One emoji, as one grapheme: a pictograph with its variation selector, skin tone or ZWJ sequence, a flag, or a keycap.
 */
const singleEmoji =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}️?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*)$/u

/** Whether `value` is a single emoji, which is all a reaction may be. */
export const isSingleEmoji = (value: string) => singleEmoji.test(value)

/**
 * Toggles `by`'s reaction `emoji` on a message: added when they haven't left it, taken back when they have. Returns the
 * message as it is now and whether the reaction was added.
 */
export async function toggleReaction(db: Db, messageId: string, emoji: string, by: string): Promise<{ message: Message; added: boolean }> {
  const trimmed = emoji.trim()
  if (!isSingleEmoji(trimmed)) throw new InvalidReactionError(`${JSON.stringify(emoji)} isn't a single emoji`)
  return db.transaction(async (tx) => {
    const [message] = await tx.select().from(messages).where(eq(messages.id, messageId))
    if (!message) throw new MessageNotFoundError('No such message')
    const added = !message.reactions.some((entry) => entry.emoji === trimmed && entry.by === by)
    const reactions = added ? [...message.reactions, { emoji: trimmed, by }] : message.reactions.filter((entry) => !(entry.emoji === trimmed && entry.by === by))
    const [updated] = await tx.update(messages).set({ reactions }).where(eq(messages.id, messageId)).returning()
    return { message: updated!, added }
  })
}

/**
 * The short address a bot knows a message by, as Grok's `[t3u]` tags: `m` and the last 8 hex digits of its id, the
 * random end of a UUIDv7.
 */
export const messageAddress = (id: string) => `m${id.slice(-8)}`

/** An address as `messageAddress` writes it. */
const addressPattern = /^m[0-9a-f]{8}$/

/**
 * The owner's newest message among `chatIds` at `address`, e.g. one a bot reacts to: of those it can read, its DM and
 * its group chats.
 */
export async function findOwnerMessage(db: Db, chatIds: readonly string[], address: string): Promise<Message | undefined> {
  const wanted = address.trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!addressPattern.test(wanted) || !chatIds.length) return undefined
  const [message] = await db
    .select()
    .from(messages)
    .where(and(inArray(messages.chatId, [...chatIds]), eq(messages.author, 'owner'), like(messages.id, `%${wanted.slice(1)}`)))
    .orderBy(desc(messages.id))
    .limit(1)
  return message
}

/** What a message says, for a quote: its text, or its files' names for one of files only. */
const quotable = (message: Message) => message.text.trim() || message.attachments.map((file) => file.name).join(', ')

/** A message on one line, cut to `max` characters with `…` (Grok's `describeMessageQuote`). */
export function quoteOf(text: string, max?: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return max !== undefined && line.length > max ? `${line.slice(0, max)}…` : line
}

/** What a reply keeps of the message it answers. */
export function replyQuoteOf(message: Message): ReplyQuote {
  return { id: message.id, author: message.author, botId: message.authorBotId, authorName: message.authorName, text: quotable(message) }
}

/**
 * What a bot reads before the owner's message that replies to another (Grok's `buildReplyContextNote`): the replied
 * message's address and its whole text.
 */
export const describeReply = (quote: ReplyQuote) => `[In reply to ${messageAddress(quote.id)}: "${quoteOf(quote.text)}"]`

/**
 * What a bot reads before the owner's message in its DM (`BotInput.preface`): its address, which `react` takes, then
 * what it replies to.
 */
export function describeOwnerPreface(message: Pick<Message, 'id' | 'replyTo'>): string {
  return [`[${messageAddress(message.id)}]`, message.replyTo && describeReply(message.replyTo)].filter(Boolean).join('\n')
}

/** The hidden cue that wakes a bot the owner reacted to (Grok's `resumeAfterReaction`); it asks for no reply. */
export const describeReaction = (emoji: string, message: Message) =>
  `[The owner reacted ${emoji} to your message: "${quoteOf(quotable(message), 80)}". You don't need to reply; act on it only if it's useful (e.g. acknowledge, adjust, or continue).]`

/**
 * The bot a reaction to `message` wakes: the bot that wrote it, to the owner, in its DM or a group. Never for a
 * message of the owner's, one between bots, or a timeline row.
 */
export const reactionWakes = (message: Message): string | undefined =>
  message.author === 'bot' && message.authorBotId && !message.direction && !isRoutineChangeCard(message.card) ? message.authorBotId : undefined

/** Whether an input's id is that of a reaction's wake: it asks for no reply, so no reminder follows it. */
export const isReactionInput = (inputId: string | undefined) => inputId?.startsWith('reaction:') ?? false
