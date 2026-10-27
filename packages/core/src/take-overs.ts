import { type Db, type Message, messages } from '@openbot/db'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { getMessage } from './chats.ts'
import { oweReply } from './owed-replies.ts'

/**
 * A take-over card's payload, as stored in `messages.card`: a computer-use session got stuck on something only the
 * owner can do (a login, a captcha, two-factor, a payment), and the bot asks them to do it on its screen.
 */
export type TakeOverCard = {
  type: 'take_over'
  /** One line telling the owner what to do on the screen. */
  instruction: string
  /** The session's goal, so the bot can go on with it once the screen is handed back. */
  goal: string
}

/** How the owner handed the screen back: they did the step, or skipped it without doing it. */
export const handBackOutcomes = ['done', 'skipped'] as const
export type HandBackOutcome = (typeof handBackOutcomes)[number]

/** A take-over card's progress, as stored in `messages.card_state`; absent while it waits for the owner. */
export type TakeOverState = { outcome: HandBackOutcome }

export class TakeOverNotFoundError extends Error {}
export class HandedBackError extends Error {}

export function isTakeOverCard(card: unknown): card is TakeOverCard {
  return typeof card === 'object' && card !== null && (card as { type?: unknown }).type === 'take_over'
}

/** How the screen was handed back, or null while the card waits for the owner. */
export function handBackOutcomeOf(message: Pick<Message, 'cardState'>): HandBackOutcome | null {
  return (message.cardState as TakeOverState | null)?.outcome ?? null
}

/** The bot's newest take-over card in its DM that still waits for the owner, if any. */
export async function findWaitingTakeOver(db: Db, chatId: string): Promise<(Message & { card: TakeOverCard }) | undefined> {
  const [waiting] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), sql`json_extract(${messages.card}, '$.type') = 'take_over'`, isNull(messages.cardState)))
    .orderBy(desc(messages.id))
    .limit(1)
  return waiting as (Message & { card: TakeOverCard }) | undefined
}

/**
 * Records how the owner handed the screen back, once: of two racing, only the first is kept. Throws
 * `TakeOverNotFoundError` when the message is no take-over card and `HandedBackError` when it was handed back already.
 */
export async function handBack(db: Db, messageId: string, outcome: HandBackOutcome): Promise<{ message: Message; card: TakeOverCard }> {
  const message = await getMessage(db, messageId)
  if (!message || !isTakeOverCard(message.card)) throw new TakeOverNotFoundError('No such take-over')
  // The bot owes the owner a reply once it has gone on, as to their message.
  const handed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ cardState: { outcome } satisfies TakeOverState })
      .where(and(eq(messages.id, messageId), isNull(messages.cardState)))
      .returning()
    if (row) await oweReply(tx, row.chatId)
    return row
  })
  if (!handed) throw new HandedBackError('The screen was already handed back')
  return { message: handed, card: message.card }
}

/** Takes back a hand-back that never reached the bot, so the owner can hand back again. */
export async function reopenTakeOver(db: Db, messageId: string): Promise<Message | undefined> {
  const [reopened] = await db.update(messages).set({ cardState: null }).where(eq(messages.id, messageId)).returning()
  return reopened
}

/** How a hand-back reaches the bot that asked: the next input of its history. */
export function describeHandBack(card: TakeOverCard, outcome: HandBackOutcome): string {
  // Grok's resume prompts (box-handoff-resume.ts), with use_computer for its Screenshot tool.
  if (outcome === 'done') {
    return (
      `The owner handed your screen back after what you asked them to do ("${card.instruction}"). Continue the goal: ` +
      `call use_computer again, starting with a screenshot to see the current state of the screen. The goal: ${card.goal}`
    )
  }
  return (
    `The owner skipped what you asked them to do on your screen ("${card.instruction}") without doing it. Treat it as ` +
    "declined: don't assume it happened, and don't immediately ask for the same step again. Continue the goal without " +
    'it if you can: skip the step or find another way. If the goal cannot go on without it, send the owner a brief ' +
    `message saying what is blocked, then stop and wait for their reply. The goal: ${card.goal}`
  )
}
