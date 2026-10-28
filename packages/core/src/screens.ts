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
 * the computer couldn't be reached stopped (with their browser profiles). Run when the server starts and whenever the
 * screen daemon restarts.
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

const syncRetryMs = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * Makes the computer's screens match the bots when the server starts and again each time the screen daemon restarts
 * (it restores the screens it last saved, which may not be the bots' now), retrying while the daemon isn't up yet (e.g. both just started).
 * `synced` settles after the first attempt either way; retries go on in the background.
 */
export function keepScreensInSync(db: Db, screens: Screens): { synced: Promise<void>; stop(): void } {
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let syncing: Promise<void> | undefined
  /** A sync under way may have started screens on the daemon from before the restart. */
  let restartedDuringSync = false
  let stopped = false
  function sync(): Promise<void> {
    if (syncing) {
      restartedDuringSync = true
      return syncing
    }
    clearTimeout(retry)
    syncing = syncScreens(db, screens)
      .then(
        () => {
          attempt = 0
        },
        (error: Error) => {
          if (attempt === 0) console.warn(`[screens] Couldn't start the bots' screens; retrying: ${error.message}`)
          if (!stopped) retry = setTimeout(sync, syncRetryMs[Math.min(attempt++, syncRetryMs.length - 1)]).unref()
        },
      )
      .finally(() => {
        syncing = undefined
        if (restartedDuringSync && !stopped) {
          restartedDuringSync = false
          void sync()
        }
      })
    return syncing
  }
  // Listening before the first sync, so a restart noticed during it is synced again.
  const stopListening = screens.onRestart(() => {
    if (stopped) return
    console.warn("[screens] The screen daemon restarted; bringing the bots' screens back")
    attempt = 0
    void sync()
  })
  return {
    synced: sync(),
    stop() {
      stopped = true
      clearTimeout(retry)
      stopListening()
    },
  }
}
