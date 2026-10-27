import { botInputs, type Db } from '@openbot/db'
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { BotInput } from './ports/agent-runtime.ts'

/** An input in a bot's queue, as kept across restarts: with its id, and how many of its runs were interrupted. */
export type KeptInput = BotInput & { id: string; attempt?: number }

/** After every input kept so far: the queue's newest place. */
const nextPosition = sql`(select coalesce(max(${botInputs.position}), 0) + 1 from ${botInputs})`

/**
 * Keeps `input` in the bot's queue; false when an input of its id was queued for the bot in the last
 * `takenInputRetentionMs`, which isn't again.
 */
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
    .set({ input, position: nextPosition, takenAt: null })
    .where(and(eq(botInputs.botId, botId), eq(botInputs.inputId, input.id)))
}

/** The bot's kept input of id `inputId`, queued or not, e.g. that of a run resumed after a restart. */
export async function keptInput(db: Db, botId: string, inputId: string): Promise<KeptInput | undefined> {
  const [row] = await db
    .select({ input: botInputs.input })
    .from(botInputs)
    .where(and(eq(botInputs.botId, botId), eq(botInputs.inputId, inputId)))
  return row?.input as KeptInput | undefined
}

/** Takes the bot's inputs `inputIds` off its queue: their run was submitted, or couldn't start. */
export async function takeInputs(db: Db, botId: string, inputIds: readonly string[]): Promise<void> {
  if (!inputIds.length) return
  await db
    .update(botInputs)
    .set({ takenAt: new Date() })
    .where(and(eq(botInputs.botId, botId), inArray(botInputs.inputId, [...inputIds])))
}

/**
 * How long an input is remembered once it left its queue, so that waking the bot with its id again does nothing: long
 * enough for a run to replay its calls once the server is back, as Grok bounds its own records (48 hours, 256 sends).
 */
export const takenInputRetentionMs = 7 * 24 * 60 * 60 * 1000

/** Forgets the inputs that left their queue more than `takenInputRetentionMs` ago. */
export async function pruneTakenInputs(db: Db, now = Date.now()): Promise<void> {
  await db.delete(botInputs).where(lt(botInputs.takenAt, new Date(now - takenInputRetentionMs)))
}

/** Every bot's queued inputs, in the order they were queued. */
export async function queuedInputs(db: Db): Promise<{ botId: string; input: KeptInput }[]> {
  const rows = await db
    .select({ botId: botInputs.botId, input: botInputs.input })
    .from(botInputs)
    .where(isNull(botInputs.takenAt))
    .orderBy(asc(botInputs.position))
  return rows.map(({ botId, input }) => ({ botId, input: input as KeptInput }))
}
