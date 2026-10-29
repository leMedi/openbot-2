import { type Db, type Message, messages } from '@openbot/db'
import { and, asc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm'
import { getMessage } from './chats.ts'
import { oweReply } from './owed-replies.ts'

export const questionOptionStyles = ['default', 'primary', 'danger'] as const
export type QuestionOptionStyle = (typeof questionOptionStyles)[number]

/** Most options a question card may offer (as in Grok Bot). */
export const maxQuestionOptions = 6

export type QuestionOption = { label: string; description: string | null; style: QuestionOptionStyle }

/** A question card's payload, as stored in `messages.card`. */
export type QuestionCard = {
  type: 'question'
  prompt: string
  details: string | null
  options: QuestionOption[]
  allowText: boolean
}

/** The owner's answer: an option by index, or their own words when the card allows it. */
export type QuestionAnswer = { option: number } | { text: string }

/**
 * A question card's progress, as stored in `messages.card_state`; absent while open. Answered or dismissed, it can't be
 * answered any more; `reminded` once the bot's input listed it as unanswered, so it isn't listed again.
 */
export type QuestionState = { answer?: QuestionAnswer; dismissed?: true; reminded?: true }

export class QuestionNotFoundError extends Error {}
/** The question was answered or dismissed already. */
export class QuestionAnsweredError extends Error {}
export class InvalidAnswerError extends Error {}

export function isQuestionCard(card: unknown): card is QuestionCard {
  return typeof card === 'object' && card !== null && (card as { type?: unknown }).type === 'question'
}

/** The card's answer, or null while it is open. */
export function questionAnswerOf(message: Pick<Message, 'cardState'>): QuestionAnswer | null {
  return (message.cardState as QuestionState | null)?.answer ?? null
}

/** Whether the card was dismissed: by the owner's ×, or when they moved on. */
export function questionDismissedOf(message: Pick<Message, 'cardState'>): boolean {
  return (message.cardState as QuestionState | null)?.dismissed ?? false
}

const isQuestion = sql`json_extract(${messages.card}, '$.type') = 'question'`
/** Neither answered nor dismissed. */
const isOpen = sql`json_extract(${messages.cardState}, '$.answer') is null and json_extract(${messages.cardState}, '$.dismissed') is null`

/** `messages.card_state` with `patch` merged in (RFC 7396: a null removes its key), so other fields survive. */
const patchState = (patch: Record<string, unknown>): SQL =>
  sql`json_patch(coalesce(${messages.cardState}, '{}'), ${JSON.stringify(patch)})`

/**
 * Records the owner's answer to a question card, once: of two answers racing, only the first is kept. Throws
 * `QuestionNotFoundError` when the message is no question card, `QuestionAnsweredError` when it was answered already,
 * and `InvalidAnswerError` for an option the card lacks or free text it doesn't allow.
 */
export async function answerQuestion(
  db: Db,
  messageId: string,
  answer: QuestionAnswer,
): Promise<{ message: Message; card: QuestionCard; answer: QuestionAnswer }> {
  const message = await getMessage(db, messageId)
  if (!message || !isQuestionCard(message.card)) throw new QuestionNotFoundError('No such question')
  const card = message.card
  if ('option' in answer) {
    if (!card.options[answer.option]) throw new InvalidAnswerError(`The question has no option ${answer.option}`)
  } else {
    if (!card.allowText) throw new InvalidAnswerError('The question takes no free-text answer')
    answer = { text: answer.text.trim() }
    if (!answer.text) throw new InvalidAnswerError('The answer is empty')
  }
  // The bot owes the owner a reply to their answer, as to their message.
  const answered = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ cardState: patchState({ answer } satisfies QuestionState) })
      .where(and(eq(messages.id, messageId), isOpen))
      .returning()
    if (row) await oweReply(tx, row.chatId)
    return row
  })
  if (!answered) throw new QuestionAnsweredError('The question was already answered or dismissed')
  return { message: answered, card, answer }
}

/** Takes back an answer that never reached the bot, so the owner can answer again. */
export async function reopenQuestion(db: Db, messageId: string): Promise<Message | undefined> {
  const [reopened] = await db.update(messages).set({ cardState: patchState({ answer: null }) }).where(eq(messages.id, messageId)).returning()
  return reopened
}

/**
 * The owner dismisses an open question card: it can't be answered any more, and the bot isn't woken. Throws
 * `QuestionNotFoundError` when the message is no question card and `QuestionAnsweredError` when it isn't open.
 */
export async function dismissQuestion(db: Db, messageId: string): Promise<Message> {
  const message = await getMessage(db, messageId)
  if (!message || !isQuestionCard(message.card)) throw new QuestionNotFoundError('No such question')
  const [dismissed] = await db
    .update(messages)
    .set({ cardState: patchState({ dismissed: true } satisfies QuestionState) })
    .where(and(eq(messages.id, messageId), isOpen))
    .returning()
  if (!dismissed) throw new QuestionAnsweredError('The question was already answered or dismissed')
  return dismissed
}

/**
 * The owner moved on: their message `messageId` dismisses the chat's open question cards posted before it, which the
 * bot's next input lists as unanswered. Returns them.
 */
export async function dismissMovedOnQuestions(db: Db, chatId: string, messageId: string): Promise<Message[]> {
  return db
    .update(messages)
    .set({ cardState: patchState({ dismissed: true } satisfies QuestionState) })
    .where(
      and(
        eq(messages.chatId, chatId),
        lt(messages.id, messageId),
        isQuestion,
        isOpen,
      ),
    )
    .returning()
}

/**
 * The questions in the bot's DM `chatId` still unanswered, open or dismissed, that its input hasn't listed yet; oldest
 * first. Its next run lists them (see `describeUnanswered`), then marks them with `markReminded`.
 */
export async function unansweredQuestions(db: Db, chatId: string): Promise<{ id: string; prompt: string }[]> {
  const rows = await db
    .select({ id: messages.id, card: messages.card })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        isQuestion,
        sql`json_extract(${messages.cardState}, '$.answer') is null`,
        sql`json_extract(${messages.cardState}, '$.reminded') is null`,
      ),
    )
    .orderBy(asc(messages.id))
  return rows.map((row) => ({ id: row.id, prompt: (row.card as QuestionCard).prompt }))
}

/** Records that the bot's input listed these questions, so it never lists them again. */
export async function markReminded(db: Db, messageIds: readonly string[]): Promise<void> {
  if (!messageIds.length) return
  await db
    .update(messages)
    .set({ cardState: patchState({ reminded: true } satisfies QuestionState) })
    .where(inArray(messages.id, [...messageIds]))
}

/** The lines starting a run's input that list the questions the owner left unanswered (Grok's wording). */
export function describeUnanswered(prompts: readonly string[]): string {
  return ['Unanswered questions:', ...prompts.map((prompt) => `- ${prompt}`)].join('\n')
}

/** How an answer reaches the bot that asked: the next input of its history. */
export function describeAnswer(card: QuestionCard, answer: QuestionAnswer): string {
  const choice =
    'option' in answer
      ? `${String.fromCharCode(65 + answer.option)}. ${card.options[answer.option]!.label}`
      : `in their own words: ${answer.text}`
  return `The owner answered your question "${card.prompt}": ${choice}`
}
