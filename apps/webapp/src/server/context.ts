import { BotRuntime, type ModelProvider, Providers } from '@openbot/agent'
import type { LiveEvent } from '@openbot/api-contract'
import { EventBus, postMessage, SecretBox } from '@openbot/core'
import type { Db } from '@openbot/db'
import { toMessageInfo } from './views.ts'

/** What every procedure runs against; built once per server start, or per test by the harness. */
export type ServerContext = {
  db: Db
  bus: EventBus<LiveEvent>
  providers: Providers
  runtime: BotRuntime
}

export async function createServerContext({
  db,
  secretKey,
  providers: modelProviders,
  agentStoragePath,
}: {
  db: Db
  /** Encrypts system credentials. */
  secretKey: string
  /** pi's model providers: all built-in ones in production, scripted fakes in tests. */
  providers: readonly ModelProvider[]
  /** pi-durable's storage file; in memory when absent. */
  agentStoragePath?: string
}): Promise<ServerContext> {
  const bus = new EventBus<LiveEvent>()
  const providers = new Providers({ db, box: new SecretBox(secretKey), providers: modelProviders })
  const runtime = await BotRuntime.open({
    db,
    models: providers.models,
    storagePath: agentStoragePath,
    async sendMessage(bot, text, idempotencyKey) {
      const { message, created } = await postMessage(db, {
        chatId: bot.chatId,
        author: 'bot',
        authorBotId: bot.id,
        authorName: bot.name,
        text,
        idempotencyKey,
      })
      if (created) bus.publish({ type: 'message.created', message: toMessageInfo(message) })
    },
    onStatus: (botId, working) => bus.publish({ type: 'bot.status', botId, working }),
  })
  return { db, bus, providers, runtime }
}
