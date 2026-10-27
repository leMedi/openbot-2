import { botInputs, type Db } from '@openbot/db'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { BotInput } from './ports/agent-runtime.ts'

/** An input in a bot's queue, as kept across restarts: with its id, and how many of its runs were interrupted. */
export type KeptInput = BotInput & { id: string; attempt?: number }

/** After every input kept so far: the queue's newest place. */
const nextPosition = sql`(select coalesce(max(${botInputs.position}), 0) + 1 from ${botInputs})`

/** Keeps `input` in the bot's queue; false when an input of its id was ever queued for the bot, which isn't again. */
export async function keepInput(db: Db, botId: string, input: KeptInput): Promise<boolean> {
  const inserted = await db
    .insert(botInputs)
    .values({ botId, inputId: input.id, input, position: nextPosition })
    .onConflictDoNothing({ target: [botInputs.botId, botInputs.inputId] })
    .returning({ id: botInputs.id })
  return inserted.length > 0
}

/** Queues a kept input again, at the back of the queue, e.g. once an interrupt stopped its run. */
export async function requeueInput(db: Db, botId: string, input: KeptInput): Promise<void> {
  await db
    .update(botInputs)
    .set({ input, position: nextPosition, submittedAt: null })
    .where(and(eq(botInputs.botId, botId), eq(botInputs.inputId, input.id)))
}

/** Takes the bot's inputs `inputIds` off its queue: their run was submitted, or couldn't start. */
export async function markInputsSubmitted(db: Db, botId: string, inputIds: readonly string[]): Promise<void> {
  if (!inputIds.length) return
  await db
    .update(botInputs)
    .set({ submittedAt: new Date() })
    .where(and(eq(botInputs.botId, botId), inArray(botInputs.inputId, [...inputIds])))
}

/** Every bot's queued inputs, in the order they were queued. */
export async function queuedInputs(db: Db): Promise<{ botId: string; input: KeptInput }[]> {
  const rows = await db
    .select({ botId: botInputs.botId, input: botInputs.input })
    .from(botInputs)
    .where(isNull(botInputs.submittedAt))
    .orderBy(asc(botInputs.position))
  return rows.map(({ botId, input }) => ({ botId, input: input as KeptInput }))
}
