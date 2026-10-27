import { basename } from 'node:path'
import { SignInNotFoundError } from '@openbot/agent'
import { contract } from '@openbot/api-contract'
import {
  answerQuestion,
  type AttachmentFile,
  type BotWithChat,
  ChatNotFoundError,
  listChatSummaries,
  markChatRead,
  setPinnedChats,
  createBot,
  describeAnswer,
  InvalidAnswerError,
  deleteBot,
  getBot,
  getChat,
  getMessage,
  mimeTypeOf,
  NameTakenError,
  listAuditEntries,
  listBots,
  listMessages,
  postMessage,
  QuestionAnsweredError,
  QuestionNotFoundError,
  reopenQuestion,
  readBotOrchestratorModes,
  readModelSettings,
  readOrchestratorModes,
  writeBotOrchestratorModes,
  updateBot,
  writeModelSettings,
  writeOrchestratorModes,
} from '@openbot/core'
import { implement, ORPCError } from '@orpc/server'
import { generateContentDisposition } from '@orpc/standard-server'
import { publishChat, type ServerContext } from './context.ts'
import { toAuditEntryInfo, toBotInfo, toChatInfo, toMessageInfo } from './views.ts'

const os = implement(contract).$context<ServerContext>()

/** Throws unless the bot's model can run, so the owner's input is never left without a bot to answer it. */
async function assertCanRun(context: ServerContext, bot: BotWithChat) {
  const model = bot.model ?? (await readModelSettings(context.db)).defaultModel
  if (!model) throw new ORPCError('PRECONDITION_FAILED', { message: 'Choose a default model first' })
  if (!(await context.providers.findModel(model))) {
    throw new ORPCError('PRECONDITION_FAILED', { message: `${model} is not available; connect its provider or choose another model` })
  }
}

/** `work`'s result, with a missing chat answered as NOT_FOUND. */
async function chatMustExist<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof ChatNotFoundError) throw new ORPCError('NOT_FOUND', { message: error.message })
    throw error
  }
}

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
      (await listBots(context.db)).map((bot) => toBotInfo(bot, context.runtime.status(bot.id))),
    ),

    create: os.bots.create.handler(async ({ context, input }) => {
      if (input.model !== null && !(await context.providers.findModel(input.model))) {
        throw new ORPCError('BAD_REQUEST', { message: `${input.model} is not a model of a connected provider` })
      }
      try {
        const bot = toBotInfo(await createBot(context.db, input), { working: false, error: null })
        context.bus.publish({ type: 'bot.created', bot })
        await publishChat(context, bot.chatId)
        return bot
      } catch (error) {
        if (error instanceof NameTakenError) throw new ORPCError('CONFLICT', { message: error.message })
        throw error
      }
    }),

    update: os.bots.update.handler(async ({ context, input: { botId, ...changes } }) => {
      if (changes.model != null && !(await context.providers.findModel(changes.model))) {
        throw new ORPCError('BAD_REQUEST', { message: `${changes.model} is not a model of a connected provider` })
      }
      try {
        const updated = await updateBot(context.db, botId, changes)
        if (!updated) throw new ORPCError('NOT_FOUND', { message: 'No such bot' })
        const bot = toBotInfo(updated, context.runtime.status(botId))
        context.bus.publish({ type: 'bot.updated', bot })
        return bot
      } catch (error) {
        if (error instanceof NameTakenError) throw new ORPCError('CONFLICT', { message: error.message })
        throw error
      }
    }),

    delete: os.bots.delete.handler(async ({ context, input }) => {
      // Deleted first, so nothing can wake the bot while its run is aborted.
      const bot = await deleteBot(context.db, input.botId)
      if (!bot) throw new ORPCError('NOT_FOUND', { message: 'No such bot' })
      // Its pi history stays orphaned in pi-durable's storage, which can't delete a conversation yet; no bot reaches it.
      await context.runtime.forget(bot)
      await context.attachments.removeChat(bot.chatId)
      context.bus.publish({ type: 'bot.deleted', botId: bot.id, chatId: bot.chatId })
    }),

    stop: os.bots.stop.handler(async ({ context, input }) => {
      if (!(await getBot(context.db, input.botId))) throw new ORPCError('NOT_FOUND', { message: 'No such bot' })
      await context.runtime.stop(input.botId)
    }),

    getOrchestratorModes: os.bots.getOrchestratorModes.handler(async ({ context, input }) => {
      const modes = await readBotOrchestratorModes(context.db, input.botId)
      if (!modes) throw new ORPCError('NOT_FOUND', { message: 'No such bot' })
      return modes
    }),

    updateOrchestratorModes: os.bots.updateOrchestratorModes.handler(async ({ context, input }) => {
      const modes = await writeBotOrchestratorModes(context.db, input.botId, input.overrides)
      if (!modes) throw new ORPCError('NOT_FOUND', { message: 'No such bot' })
      return modes
    }),

    audit: os.bots.audit.handler(async ({ context, input }) => {
      if (!(await getBot(context.db, input.botId))) throw new ORPCError('NOT_FOUND', { message: 'No such bot' })
      return (await listAuditEntries(context.db, input.botId)).map(toAuditEntryInfo)
    }),
  },

  chats: {
    list: os.chats.list.handler(async ({ context }) => (await listChatSummaries(context.db)).map(toChatInfo)),

    read: os.chats.read.handler(async ({ context, input }) => {
      await chatMustExist(markChatRead(context.db, input.chatId, input.upTo))
      return (await publishChat(context, input.chatId))!
    }),

    setPinned: os.chats.setPinned.handler(async ({ context, input }) => {
      const changed = await chatMustExist(setPinnedChats(context.db, input.chatIds))
      const chats = (await listChatSummaries(context.db)).map(toChatInfo)
      for (const chat of chats) if (changed.includes(chat.id)) context.bus.publish({ type: 'chat.updated', chat })
      return chats
    }),

    messages: os.chats.messages.handler(async ({ context, input }) => {
      if (!(await getChat(context.db, input.chatId))) throw new ORPCError('NOT_FOUND', { message: 'No such chat' })
      return (await listMessages(context.db, input.chatId)).map(toMessageInfo)
    }),

    send: os.chats.send.handler(async ({ context, input }) => {
      const chat = await getChat(context.db, input.chatId)
      const bot = chat?.botId ? await getBot(context.db, chat.botId) : undefined
      if (!bot) throw new ORPCError('NOT_FOUND', { message: 'No such chat' })
      await assertCanRun(context, bot)
      // Saved one at a time, so two files of one name get distinct names.
      const files: AttachmentFile[] = []
      for (const file of input.files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const path = await context.computer.saveUpload(bot, file.name, bytes)
        files.push({ name: basename(path), mimeType: file.type || mimeTypeOf(file.name), path, bytes })
      }
      const attachments = await context.attachments.save(chat!.id, files)
      const { message } = await postMessage(context.db, {
        chatId: chat!.id,
        author: 'owner',
        authorName: 'You',
        text: input.text,
        attachments,
      }).catch(async (error) => {
        // The uploads stay on the computer; only the copies of a message never posted go.
        await context.attachments.discard(chat!.id, attachments)
        throw error
      })
      const info = toMessageInfo(message)
      context.bus.publish({ type: 'message.created', message: info })
      await publishChat(context, chat!.id)
      await context.runtime.wake(bot.id, { lane: 'owner', text: input.text, attachments, id: message.id })
      return info
    }),

    attachment: os.chats.attachment.handler(async ({ context, input }) => {
      const message = await getMessage(context.db, input.messageId)
      const attachment = message?.attachments.find((entry) => entry.id === input.attachmentId)
      const bytes = attachment && (await context.attachments.read(message!.chatId, attachment.id))
      if (!bytes) throw new ORPCError('NOT_FOUND', { message: 'No such attachment' })
      return {
        headers: {
          // Always a download, and never run as a page of this origin, whatever the file holds.
          'content-disposition': generateContentDisposition(attachment.name, 'attachment'),
          'content-security-policy': 'sandbox',
          'x-content-type-options': 'nosniff',
        },
        body: new File([bytes], attachment.name, { type: attachment.mimeType }),
      }
    }),

    answer: os.chats.answer.handler(async ({ context, input }) => {
      const asked = await getMessage(context.db, input.messageId)
      const bot = asked?.authorBotId ? await getBot(context.db, asked.authorBotId) : undefined
      if (!asked?.card || !bot) throw new ORPCError('NOT_FOUND', { message: 'No such question' })
      await assertCanRun(context, bot)
      let answered
      try {
        answered = await answerQuestion(context.db, input.messageId, input.answer)
      } catch (error) {
        if (error instanceof QuestionNotFoundError) throw new ORPCError('NOT_FOUND', { message: error.message })
        if (error instanceof QuestionAnsweredError) throw new ORPCError('CONFLICT', { message: error.message })
        if (error instanceof InvalidAnswerError) throw new ORPCError('BAD_REQUEST', { message: error.message })
        throw error
      }
      const { message, card, answer } = answered
      const info = toMessageInfo(message)
      context.bus.publish({ type: 'message.updated', message: info })
      await publishChat(context, message.chatId)
      try {
        // The owner's answer: it steers a run that is still going, like any message of theirs.
        await context.runtime.wake(bot.id, { lane: 'owner', text: describeAnswer(card, answer), id: `answer:${message.id}` })
      } catch (error) {
        // An answer the bot never got isn't kept, so the owner can answer again.
        const reopened = await reopenQuestion(context.db, message.id)
        if (reopened) {
          context.bus.publish({ type: 'message.updated', message: toMessageInfo(reopened) })
          await publishChat(context, reopened.chatId)
        }
        throw error
      }
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

  orchestrator: {
    getModes: os.orchestrator.getModes.handler(({ context }) => readOrchestratorModes(context.db)),

    updateModes: os.orchestrator.updateModes.handler(({ context, input }) => writeOrchestratorModes(context.db, input)),
  },
})

export type Router = typeof router
