import type { NewBot } from '@openbot/api-contract'
import { createBot, createGroupChat, listBots, listChatSummaries } from '@openbot/core'
import type { Db } from '@openbot/db'

/** Bots `pnpm dev:seed` adds to a dev instance, so there is something to click on after `dev:reset`. */
export const sampleBots: NewBot[] = [
  {
    name: 'Ada',
    title: 'Researcher',
    instructions: 'Ada digs into questions, reads the sources and answers with what she found and how sure she is.',
    avatarShape: 'blob',
    avatarColor: 'violet',
    model: null,
  },
  {
    name: 'Linus',
    title: 'Engineer',
    instructions: 'Linus writes and fixes code on his computer and explains what he changed in a few lines.',
    avatarShape: 'hex',
    avatarColor: 'blue',
    model: null,
  },
  {
    name: 'Grace',
    title: 'Planner',
    instructions: 'Grace breaks goals into steps, keeps track of who does what and reminds people when things slip.',
    avatarShape: 'squircle',
    avatarColor: 'green',
    model: null,
  },
]

export const sampleGroupTitle = 'Launch team'

/**
 * Adds the sample bots and a group chat with all of them. Safe to run again: a bot whose name is taken (ignoring case)
 * is reused, and the group is only created once. Writes rows directly, so open tabs see them after a reload.
 */
export async function seedSampleData(db: Db): Promise<void> {
  const existing = await listBots(db)
  const members: string[] = []
  for (const sample of sampleBots) {
    const bot = existing.find((bot) => bot.name.toLowerCase() === sample.name.toLowerCase()) ?? (await createBot(db, sample))
    members.push(bot.id)
  }

  const chats = await listChatSummaries(db)
  if (!chats.some((chat) => chat.kind === 'group' && chat.title === sampleGroupTitle)) {
    await createGroupChat(db, { title: sampleGroupTitle, members })
  }
}
