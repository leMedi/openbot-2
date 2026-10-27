import { type Db, type Message, messages } from '@openbot/db'
import { and, eq, isNull } from 'drizzle-orm'
import { getMessage } from './chats.ts'

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

/** A question card's progress, as stored in `messages.card_state`; absent while open. */
export type QuestionState = { answer: QuestionAnswer }

export class QuestionNotFoundError extends Error {}
export class QuestionAnsweredError extends Error {}
export class InvalidAnswerError extends Error {}

export function isQuestionCard(card: unknown): card is QuestionCard {
  return typeof card === 'object' && card !== null && (card as { type?: unknown }).type === 'question'
}

/** The card's answer, or null while it is open. */
export function questionAnswerOf(message: Pick<Message, 'cardState'>): QuestionAnswer | null {
  return (message.cardState as QuestionState | null)?.answer ?? null
}

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
  const [answered] = await db
    .update(messages)
    .set({ cardState: { answer } satisfies QuestionState })
    .where(and(eq(messages.id, messageId), isNull(messages.cardState)))
    .returning()
  if (!answered) throw new QuestionAnsweredError('The question was already answered')
  return { message: answered, card, answer }
}

/** Takes back an answer that never reached the bot, so the owner can answer again. */
export async function reopenQuestion(db: Db, messageId: string): Promise<Message | undefined> {
  const [reopened] = await db.update(messages).set({ cardState: null }).where(eq(messages.id, messageId)).returning()
  return reopened
}

/** How an answer reaches the bot that asked: the next input of its history. */
export function describeAnswer(card: QuestionCard, answer: QuestionAnswer): string {
  const choice =
    'option' in answer
      ? `${String.fromCharCode(65 + answer.option)}. ${card.options[answer.option]!.label}`
      : `in their own words: ${answer.text}`
  return `The owner answered your question "${card.prompt}": ${choice}`
}
