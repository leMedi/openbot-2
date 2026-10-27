import { type BotComputer, BotRuntime, type BotTool, type ModelProvider, Providers } from '@openbot/agent'
import type { ChatInfo, LiveEvent } from '@openbot/api-contract'
import {
  AllowAllOrchestrator,
  AttachmentStore,
  EventBus,
  getChatSummary,
  type Orchestrator,
  postMessage,
  type Screens,
  SecretBox,
  syncScreens,
} from '@openbot/core'
import type { Db } from '@openbot/db'
import type { ScreenTickets } from './screen-stream.ts'
import { toChatInfo, toMessageInfo } from './views.ts'

/** What every procedure runs against; built once per server start, or per test by the harness. */
export type ServerContext = {
  db: Db
  bus: EventBus<LiveEvent>
  providers: Providers
  runtime: BotRuntime
  /** Where bots work: the owner's files are saved there. */
  computer: BotComputer
  /** The copies of messages' files the owner downloads. */
  attachments: AttachmentStore
  /** Every bot's screen on the computer. */
  screens: Screens
  /** Tickets to screens' streams, redeemed by the stream proxy. */
  screenTickets: ScreenTickets
  /** Settles once the computer's screens first match the bots (or the computer couldn't be reached at all). */
  screensSynced: Promise<void>
}

/** Tells every tab how a chat now looks in the sidebar, after a message, a read or a pin; returns that. */
export async function publishChat({ db, bus }: Pick<ServerContext, 'db' | 'bus'>, chatId: string): Promise<ChatInfo | undefined> {
  const summary = await getChatSummary(db, chatId)
  if (!summary) return undefined
  const chat = toChatInfo(summary)
  bus.publish({ type: 'chat.updated', chat })
  return chat
}

export async function createServerContext({
  db,
  secretKey,
  providers: modelProviders,
  agentStoragePath,
  orchestrator = new AllowAllOrchestrator(),
  computer,
  attachmentsDir,
  screens,
  screenTickets,
  tools,
}: {
  db: Db
  /** Encrypts system credentials. */
  secretKey: string
  /** pi's model providers: all built-in ones in production, scripted fakes in tests. */
  providers: readonly ModelProvider[]
  /** pi-durable's storage file; in memory when absent. */
  agentStoragePath?: string
  /** Reviews bots' side-effecting actions; allows everything in P0. */
  orchestrator?: Orchestrator
  /** Where bots' shell and file tools run: the real computer, or a fake in tests. */
  computer: BotComputer
  /** Where the server keeps copies of messages' files, in its data dir. */
  attachmentsDir: string
  /** Every bot's screen: the screen daemon's, or the fake's in tests. */
  screens: Screens
  screenTickets: ScreenTickets
  /** Tools beyond the built-in ones, e.g. a test's. */
  tools?: BotTool[]
}): Promise<ServerContext> {
  const bus = new EventBus<LiveEvent>()
  const attachments = new AttachmentStore(attachmentsDir)
  const providers = new Providers({ db, box: new SecretBox(secretKey), providers: modelProviders })
  const runtime = await BotRuntime.open({
    db,
    models: providers.models,
    storagePath: agentStoragePath,
    orchestrator,
    computer,
    tools,
    async sendMessage(bot, { text, attachments: files }, idempotencyKey) {
      const saved = await attachments.save(bot.chatId, files)
      const posted = await postMessage(db, {
        chatId: bot.chatId,
        author: 'bot',
        authorBotId: bot.id,
        authorName: bot.name,
        text,
        attachments: saved,
        idempotencyKey,
      }).catch(async (error) => {
        await attachments.discard(bot.chatId, saved)
        throw error
      })
      if (!posted.created) {
        // A replayed call: its message, and the copies it kept, were posted the first time.
        await attachments.discard(bot.chatId, saved)
        return
      }
      const { message } = posted
      bus.publish({ type: 'message.created', message: toMessageInfo(message) })
      await publishChat({ db, bus }, bot.chatId)
    },
    async askQuestion(bot, card, idempotencyKey) {
      const { message, created } = await postMessage(db, {
        chatId: bot.chatId,
        author: 'bot',
        authorBotId: bot.id,
        authorName: bot.name,
        // The prompt doubles as the message's text, e.g. for previews.
        text: card.prompt,
        card,
        idempotencyKey,
      })
      if (!created) return
      bus.publish({ type: 'message.created', message: toMessageInfo(message) })
      await publishChat({ db, bus }, bot.chatId)
    },
    onStatus: (botId, status) => bus.publish({ type: 'bot.status', botId, ...status }),
  })
  const screensSynced = keepScreensInSync(db, screens)
  return { db, bus, providers, runtime, computer, attachments, screens, screenTickets, screensSynced }
}

const syncRetryMs = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * Makes the computer's screens match the bots when the server starts, retrying while the screen daemon isn't up yet
 * (e.g. both just started). Settles after the first attempt either way; retries go on in the background.
 */
function keepScreensInSync(db: Db, screens: Screens): Promise<void> {
  return new Promise((settle) => {
    let attempt = 0
    const sync = () =>
      syncScreens(db, screens).then(settle, (error: Error) => {
        if (attempt === 0) console.warn(`[screens] Couldn't start the bots' screens; retrying: ${error.message}`)
        settle()
        setTimeout(sync, syncRetryMs[Math.min(attempt++, syncRetryMs.length - 1)]).unref()
      })
    void sync()
  })
}
