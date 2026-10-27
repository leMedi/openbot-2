import type { Db } from '@openbot/db'
import { type BotWithChat, listBots, withDisplay } from './bots.ts'
import type { Screens, ScreenStatus } from './ports/computer.ts'

/** Starts the bot's screen at its display, or keeps it running. */
export async function startScreen(db: Db, screens: Screens, bot: BotWithChat): Promise<ScreenStatus> {
  const { id, name, displayNumber } = await withDisplay(db, bot)
  return screens.start({ id, name, display: displayNumber })
}

/**
 * Makes the computer's screens match the bots: every bot's screen kept running, and the screens of bots deleted while
 * the computer couldn't be reached stopped (with their browser profiles). Run when the server starts.
 */
export async function syncScreens(db: Db, screens: Screens): Promise<void> {
  const bots = await listBots(db)
  const known = new Set(bots.map((bot) => bot.id))
  // Stopped first: a deleted bot's display may since have been given to another.
  for (const screen of await screens.list()) {
    if (!known.has(screen.botId)) await screens.stop({ id: screen.botId, name: screen.botId })
  }
  for (const bot of bots) await startScreen(db, screens, bot)
}
