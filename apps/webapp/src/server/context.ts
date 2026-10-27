import { type BotComputer, BotRuntime, type BotTool, type ModelProvider, Providers } from '@openbot/agent'
import type { ChatInfo, LiveEvent } from '@openbot/api-contract'
import { AllowAllOrchestrator, EventBus, getChatSummary, type Orchestrator, postMessage, SecretBox } from '@openbot/core'
import type { Db } from '@openbot/db'
import { toChatInfo, toMessageInfo } from './views.ts'

/** What every procedure runs against; built once per server start, or per test by the harness. */
export type ServerContext = {
  db: Db
  bus: EventBus<LiveEvent>
  providers: Providers
  runtime: BotRuntime
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
  /** Tools beyond the built-in ones, e.g. a test's. */
  tools?: BotTool[]
}): Promise<ServerContext> {
  const bus = new EventBus<LiveEvent>()
  const providers = new Providers({ db, box: new SecretBox(secretKey), providers: modelProviders })
  const runtime = await BotRuntime.open({
    db,
    models: providers.models,
    storagePath: agentStoragePath,
    orchestrator,
    computer,
    tools,
    async sendMessage(bot, text, idempotencyKey) {
      const { message, created } = await postMessage(db, {
        chatId: bot.chatId,
        author: 'bot',
        authorBotId: bot.id,
        authorName: bot.name,
        text,
        idempotencyKey,
      })
      if (!created) return
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
  return { db, bus, providers, runtime }
}
