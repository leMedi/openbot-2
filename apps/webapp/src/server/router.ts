import { SignInNotFoundError } from '@openbot/agent'
import { contract } from '@openbot/api-contract'
import {
  createBot,
  getBot,
  getChat,
  HandleTakenError,
  listBots,
  listMessages,
  postMessage,
  readModelSettings,
  writeModelSettings,
} from '@openbot/core'
import { implement, ORPCError } from '@orpc/server'
import type { ServerContext } from './context.ts'
import { toBotInfo, toMessageInfo } from './views.ts'

const os = implement(contract).$context<ServerContext>()

export const router = os.router({
  health: os.health.handler(async ({ context }) => {
    await context.db.$client.execute('select 1')
    return { status: 'ok' as const, epoch: context.bus.epoch }
  }),

  events: os.events.handler(async function* ({ context, input, signal }) {
    const { bus } = context
    const resumed = input?.epoch === bus.epoch && input.seq !== undefined && bus.canResume(input.seq)
    // Subscribe before greeting so nothing published in between is lost.
    const live = bus.subscribe(signal, { after: resumed ? input.seq : undefined })
    yield { epoch: bus.epoch, seq: resumed ? input.seq! : bus.seq, event: { type: 'hello' as const, resumed } }
    yield* live
  }),

  onboarding: {
    status: os.onboarding.status.handler(async ({ context }) => {
      const [providers, settings, bots] = await Promise.all([
        context.providers.list(),
        readModelSettings(context.db),
        listBots(context.db),
      ])
      const steps = {
        provider: providers.some((provider) => provider.connection),
        defaultModel: settings.defaultModel !== null,
        bot: bots.length > 0,
      }
      return { ...steps, done: steps.provider && steps.defaultModel && steps.bot }
    }),
  },

  bots: {
    list: os.bots.list.handler(async ({ context }) =>
      (await listBots(context.db)).map((bot) => toBotInfo(bot, context.runtime.isWorking(bot.id))),
    ),

    create: os.bots.create.handler(async ({ context, input }) => {
      if (input.model !== null && !(await context.providers.findModel(input.model))) {
        throw new ORPCError('BAD_REQUEST', { message: `${input.model} is not a model of a connected provider` })
      }
      try {
        const bot = toBotInfo(await createBot(context.db, input), false)
        context.bus.publish({ type: 'bot.created', bot })
        return bot
      } catch (error) {
        if (error instanceof HandleTakenError) throw new ORPCError('CONFLICT', { message: error.message })
        throw error
      }
    }),
  },

  chats: {
    messages: os.chats.messages.handler(async ({ context, input }) => {
      if (!(await getChat(context.db, input.chatId))) throw new ORPCError('NOT_FOUND', { message: 'No such chat' })
      return (await listMessages(context.db, input.chatId)).map(toMessageInfo)
    }),

    send: os.chats.send.handler(async ({ context, input }) => {
      const chat = await getChat(context.db, input.chatId)
      const bot = chat?.botId ? await getBot(context.db, chat.botId) : undefined
      if (!bot) throw new ORPCError('NOT_FOUND', { message: 'No such chat' })
      // Checked before posting, so a message is never left without a bot to answer it.
      const model = bot.model ?? (await readModelSettings(context.db)).defaultModel
      if (!model) throw new ORPCError('PRECONDITION_FAILED', { message: 'Choose a default model first' })
      if (!(await context.providers.findModel(model))) {
        throw new ORPCError('PRECONDITION_FAILED', { message: `${model} is not available; connect its provider or choose another model` })
      }
      const { message } = await postMessage(context.db, { chatId: chat!.id, author: 'owner', authorName: 'You', text: input.text })
      const info = toMessageInfo(message)
      context.bus.publish({ type: 'message.created', message: info })
      await context.runtime.wake(bot.id, { lane: 'owner', text: input.text, id: message.id })
      return info
    }),
  },

  providers: {
    list: os.providers.list.handler(({ context }) => context.providers.list()),

    connect: os.providers.connect.handler(async function* ({ context, input, signal }) {
      const provider = (await context.providers.list()).find((entry) => entry.id === input.providerId)
      if (!provider) throw new ORPCError('NOT_FOUND', { message: `Unknown provider ${input.providerId}` })
      if (!provider.methods.some((entry) => entry.method === input.method)) {
        throw new ORPCError('BAD_REQUEST', { message: `${provider.name} has no ${input.method} sign-in` })
      }
      yield* context.providers.signIn(input.providerId, input.method, signal)
    }),

    answer: os.providers.answer.handler(({ context, input }) => {
      try {
        context.providers.answer(input.signInId, input.promptId, input.value)
      } catch (error) {
        if (error instanceof SignInNotFoundError) throw new ORPCError('NOT_FOUND', { message: error.message })
        throw error
      }
    }),

    disconnect: os.providers.disconnect.handler(({ context, input }) => context.providers.disconnect(input.providerId)),
  },

  models: {
    list: os.models.list.handler(({ context }) => context.providers.listModels()),

    getSettings: os.models.getSettings.handler(({ context }) => readModelSettings(context.db)),

    updateSettings: os.models.updateSettings.handler(async ({ context, input }) => {
      for (const [setting, ref] of [
        ['defaultModel', input.defaultModel],
        ['computerUseModel', input.computerUseModel],
      ] as const) {
        if (ref == null) continue
        const model = await context.providers.findModel(ref)
        if (!model) throw new ORPCError('BAD_REQUEST', { message: `${ref} is not a model of a connected provider` })
        if (setting === 'computerUseModel' && !model.vision) {
          throw new ORPCError('BAD_REQUEST', { message: `${model.name} can't see images, so it can't use a computer` })
        }
      }
      return writeModelSettings(context.db, input)
    }),
  },
})

export type Router = typeof router
