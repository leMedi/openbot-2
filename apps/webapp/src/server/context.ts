import { type BotComputer, BotRuntime, type BotTool, type ModelProvider, Providers } from '@openbot/agent'
import type { ChatInfo, LiveEvent } from '@openbot/api-contract'
import {
  AllowAllOrchestrator,
  type AttachmentFile,
  AttachmentStore,
  type BotWithChat,
  type ChatSummary,
  type Browser,
  type Desktop,
  EventBus,
  getChatSummary,
  GroupRounds,
  type Orchestrator,
  postMessage,
  type Screens,
  SecretBox,
  syncScreens,
} from '@openbot/core'
import type { Db } from '@openbot/db'
import { ScreenHolds } from './screen-holds.ts'
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
  /** Screens the owner has taken over; computer-use sessions wait while one is held. */
  screenHolds: ScreenHolds
  /** Settles once the computer's screens first match the bots (or the computer couldn't be reached at all). */
  screensSynced: Promise<void>
  /** Plays group chats' rounds of member turns. */
  rounds: GroupRounds
}

/** A chat as the sidebar shows it, with the member taking its turn in a group. */
export const chatInfoOf = ({ rounds }: Pick<ServerContext, 'rounds'>, summary: ChatSummary): ChatInfo => toChatInfo(summary, rounds.speaking(summary.id))

/** Tells every tab how a chat now looks in the sidebar, after a message, a read or a pin; returns that. */
export async function publishChat(
  { db, bus, rounds }: Pick<ServerContext, 'db' | 'bus' | 'rounds'>,
  chatId: string,
): Promise<ChatInfo | undefined> {
  const summary = await getChatSummary(db, chatId)
  if (!summary) return undefined
  const chat = chatInfoOf({ rounds }, summary)
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
  browser,
  desktop,
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
  /** Each bot's own browser on its screen: over CDP, or the fake's in tests. */
  browser: Browser
  /** Each bot's desktop apps on its screen: through its cua-driver, or the fake's in tests. Closed with the runtime. */
  desktop: Desktop & { close?(): Promise<void> }
  /** Where the server keeps copies of messages' files, in its data dir. */
  attachmentsDir: string
  /** Every bot's screen: the screen daemon's, or the fake's in tests. */
  screens: Screens
  screenTickets: ScreenTickets
  /** Tools beyond the built-in ones, e.g. a test's. */
  tools?: BotTool[]
}): Promise<ServerContext> {
  const bus = new EventBus<LiveEvent>()
  const screenHolds = new ScreenHolds()
  const attachments = new AttachmentStore(attachmentsDir)
  const providers = new Providers({ db, box: new SecretBox(secretKey), providers: modelProviders })
  // Made before the runtime, whose resumed runs may post to groups as it opens; turns wait for it to be open.
  let opened!: (runtime: BotRuntime) => void
  const runtimeOpen = new Promise<BotRuntime>((resolve) => (opened = resolve))
  const rounds = new GroupRounds({
    db,
    takeTurn: async (botId, input) => (await runtimeOpen).takeTurn(botId, input),
    onSpeaking: (chatId) => void publish(chatId).catch((error) => console.error("[groups] Couldn't show who is taking a turn:", error)),
  })
  const publish = (chatId: string) => publishChat({ db, bus, rounds }, chatId)
  /** Posts a bot's message with copies of its files to `chatId`; returns it, or undefined for a replayed call's. */
  async function postBotMessage(bot: BotWithChat, chatId: string, text: string, files: AttachmentFile[], idempotencyKey: string) {
    const saved = await attachments.save(chatId, files)
    const posted = await postMessage(db, {
      chatId,
      author: 'bot',
      authorBotId: bot.id,
      authorName: bot.name,
      text,
      attachments: saved,
      idempotencyKey,
    }).catch(async (error) => {
      await attachments.discard(chatId, saved)
      throw error
    })
    if (!posted.created) {
      // A replayed call: its message, and the copies it kept, were posted the first time.
      await attachments.discard(chatId, saved)
      return undefined
    }
    bus.publish({ type: 'message.created', message: toMessageInfo(posted.message) })
    await publish(chatId)
    return posted.message
  }
  const runtime = await BotRuntime.open({
    db,
    models: providers.models,
    storagePath: agentStoragePath,
    orchestrator,
    computer,
    browser,
    desktop,
    tools,
    async sendMessage(bot, chatId, { text, attachments: files }, idempotencyKey) {
      await postBotMessage(bot, chatId, text, files, idempotencyKey)
    },
    async messageGroup(sender, group, { text, attachments: files }, idempotencyKey) {
      const message = await postBotMessage(sender, group.id, text, files, idempotencyKey)
      // The other members answer it in rounds, as they answer the owner; rounds going on read it in their turns.
      if (message) void rounds.startUnlessPlaying(group.id, message)
    },
    async messageBot(sender, recipient, { text, attachments: files }, idempotencyKey) {
      // One entry in each DM, each with its own copies of the files: either DM can go with its bot.
      const sides = [
        { bot: sender, other: recipient, direction: 'to' as const },
        { bot: recipient, other: sender, direction: 'from' as const },
      ]
      const posted = []
      for (const { bot, other, direction } of sides) {
        const saved = await attachments.save(bot.chatId, files)
        const result = await postMessage(db, {
          chatId: bot.chatId,
          author: 'bot',
          authorBotId: sender.id,
          authorName: sender.name,
          text,
          attachments: saved,
          direction,
          peerBotId: other.id,
          peerName: other.name,
          idempotencyKey: `${idempotencyKey}:${direction}`,
        }).catch(async (error) => {
          await attachments.discard(bot.chatId, saved)
          throw error
        })
        // A replayed call: its message, and the copies it kept, were posted the first time.
        if (!result.created) await attachments.discard(bot.chatId, saved)
        posted.push(result)
      }
      // Both are told once either is new: a call replayed after the sender's copy alone was posted tells it now.
      if (!posted.some(({ created }) => created)) return posted[1]!.message
      for (const { message } of posted) {
        bus.publish({ type: 'message.created', message: toMessageInfo(message) })
        await publish(message.chatId)
      }
      return posted[1]!.message
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
      await publish(bot.chatId)
    },
    async requestTakeOver(bot, card, idempotencyKey) {
      const { message, created } = await postMessage(db, {
        chatId: bot.chatId,
        author: 'bot',
        authorBotId: bot.id,
        authorName: bot.name,
        // The instruction doubles as the message's text, e.g. for previews.
        text: card.instruction,
        card,
        idempotencyKey,
      })
      if (!created) return
      bus.publish({ type: 'message.created', message: toMessageInfo(message) })
      await publish(bot.chatId)
    },
    screenFree: (botId) => screenHolds.whenFree(botId),
    onStatus: (botId, status) => bus.publish({ type: 'bot.status', botId, ...status }),
  })
  opened(runtime)
  const screensSynced = keepScreensInSync(db, screens)
  return { db, bus, providers, runtime, computer, attachments, screens, screenTickets, screenHolds, screensSynced, rounds }
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
