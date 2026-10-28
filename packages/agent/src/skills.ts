import { dirname } from 'node:path'
import { bots, type Db } from '@openbot/db'
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent'
import { eq } from 'drizzle-orm'

/** A skill a bot may read: its name and description, and its `SKILL.md` on the bot's computer. */
export type PromptSkill = { name: string; description: string; filePath: string }

/**
 * The bot's skills block for its compaction epoch `epoch`, in pi's format (each skill's name, description and file, which
 * the bot reads with its read tool when a task matches): rendered from `skills` the first time the epoch is asked for,
 * then the same until the epoch changes, so a grant or revoke shows from the bot's next epoch. Unlike the memory and
 * routines blocks, nothing thaws it.
 */
export async function frozenSkillsBlock(db: Db, botId: string, epoch: string | null, skills: () => Promise<PromptSkill[]>): Promise<string> {
  const [row] = await db.select({ skillsBlock: bots.skillsBlock }).from(bots).where(eq(bots.id, botId))
  if (row?.skillsBlock && row.skillsBlock.epoch === epoch) return row.skillsBlock.text
  const text = formatSkillsForPrompt(
    (await skills()).map((skill) => ({
      ...skill,
      baseDir: dirname(skill.filePath),
      sourceInfo: { path: skill.filePath, source: 'plugin', scope: 'temporary', origin: 'package' },
      disableModelInvocation: false,
    })),
  ).trim()
  await db.update(bots).set({ skillsBlock: { epoch, text } }).where(eq(bots.id, botId))
  return text
}
