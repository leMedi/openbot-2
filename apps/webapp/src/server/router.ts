import { basename } from 'node:path'
import { SignInNotFoundError } from '@openbot/agent'
import { contract } from '@openbot/api-contract'
import { ScreenDaemonError } from '@openbot/computer'
import {
  answerQuestion,
  type AttachmentFile,
  type BotWithChat,
  ChatNotFoundError,
  createGroup,
  deleteGroup,
  detectTimeZone,
  getGroup,
  GroupMembersError,
  listGroups,
  listChatSummaries,
  markChatRead,
  setPinnedChats,
  createBot,
  describeAnswer,
  dismissMovedOnQuestions,
  dismissQuestion,
  describeHandBack,
  handBack,
  HandedBackError,
  InvalidAnswerError,
  InvalidTimeZoneError,
  deleteBot,
  getBot,
  getChat,
  getMessage,
  mimeTypeOf,
  NameTakenError,
  listAuditEntries,
  listBotFacts,
  listBots,
  listMessages,
  postMessage,
  QuestionAnsweredError,
  QuestionNotFoundError,
  reopenQuestion,
  reopenTakeOver,
  readBotOrchestratorModes,
  readModelSettings,
  readOrchestratorModes,
  readTimeZone,
  screenSize,
  startScreen,
  TakeOverNotFoundError,
  writeBotOrchestratorModes,
  updateBot,
  updateGroup,
  writeModelSettings,
  writeOrchestratorModes,
  writeTimeZone,
  type TimeZoneWrite,
} from '@openbot/core'
import { implement, ORPCError } from '@orpc/server'
import { generateContentDisposition } from '@orpc/standard-server'
import { chatInfoOf, publishChat, type ServerContext } from './context.ts'
import { screenStreamUrl } from './screen-stream.ts'
import { toAuditEntryInfo, toBotInfo, toFactInfo, toMessageInfo } from './views.ts'

const os = implement(contract).$context<ServerContext>()

/** Writes the owner's time zone with `write`, refusing an invalid one; a change is published for scheduled jobs. */
async function setTimeZone(context: ServerContext, write: () => Promise<TimeZoneWrite>) {
  try {
    const { timeZone, changed } = await write()
    if (changed) context.bus.publish({ type: 'timeZone.updated', timeZone })
    return { timeZone }
  } catch (error) {
    if (error instanceof InvalidTimeZoneError) throw new ORPCError('BAD_REQUEST', { message: error.message })
    throw error
  }
}

/** Throws unless the bot's model can run, so the owner's input is never left without a bot to answer it. */
async function assertCanRun(context: ServerContext, bot: BotWithChat) {
  if (context.computer.unavailable) throw new ORPCError('PRECONDITION_FAILED', { message: context.computer.unavailable })
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

/** `work`'s result, with members a group chat can't have answered as BAD_REQUEST. */
async function membersMustFit<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof GroupMembersError) throw new ORPCError('BAD_REQUEST', { message: error.message })
    throw error
  }
}

/** Tells every tab how the group chats `botId` is in look now, e.g. named after it as it was renamed. */
async function publishGroupsOf(context: ServerContext, botId: string) {
  for (const group of await listGroups(context.db, botId)) await publishChat(context, group.id)
}

/**
 * Posts the owner's message in a group chat, with their files saved in the group's shared folder, and starts the members'
 * rounds answering it. Throws unless every member can run, so the message is never left without members to answer it.
 */
async function sendToGroup(context: ServerContext, chatId: string, text: string, uploads: readonly File[] = []) {
  const group = await getGroup(context.db, chatId)
  if (!group) throw new ORPCError('NOT_FOUND', { message: 'No such chat' })
  if (!group.members.length) throw new ORPCError('PRECONDITION_FAILED', { message: 'Add members to this group chat first' })
  for (const member of group.members) {
    const bot = await getBot(context.db, member)
    if (bot) await assertCanRun(context, bot)
  }
  // Saved one at a time, so two files of one name get distinct names.
  const files: AttachmentFile[] = []
  for (const file of uploads) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const path = await context.computer.saveGroupUpload(chatId, file.name, bytes)
    files.push({ name: basename(path), mimeType: file.type || mimeTypeOf(file.name), path, bytes })
  }
  const attachments = await context.attachments.save(chatId, files)
  const { message } = await postMessage(context.db, { chatId, author: 'owner', authorName: 'You', text, attachments }).catch(async (error) => {
    // The files stay in the shared folder; only the copies of a message never posted go.
    await context.attachments.discard(chatId, attachments)
    throw error
  })
  const info = toMessageInfo(message)
  context.bus.publish({ type: 'message.created', message: info })
  await publishChat(context, chatId)
  void context.rounds.start(chatId, message)
  return info
}

/** The bot, or NOT_FOUND. */
async function botMustExist(context: ServerContext, botId: string): Promise<BotWithChat> {
  const bot = await getBot(context.db, botId)
  if (!bot) throw new ORPCError('NOT_FOUND', { message: 'No such bot' })
  return bot
}

/**
 * The bot's screen as the computer reports it, never started here: the server brings screens back when it starts and
 * when the screen daemon restarts. SERVICE_UNAVAILABLE when the computer can't be reached.
 */
async function screenOf(context: ServerContext, bot: BotWithChat) {
  try {
    return await context.screens.status(bot)
  } catch (error) {
    if (!(error instanceof ScreenDaemonError)) throw error
    console.error(`[screens] Can't reach ${bot.name}'s screen:`, error.message)
    throw new ORPCError('SERVICE_UNAVAILABLE', { message: `Can't reach ${bot.name}'s screen` })
  }
}

/** The running release's version, which its `bin/start` sets; `dev` when running the repo. */
const runningVersion = process.env.OPENBOT_VERSION || 'dev'

export const router = os.router({
  health: os.health.handler(async ({ context }) => {
    await context.db.$client.execute('select 1')
    return { status: 'ok' as const, epoch: context.bus.epoch, version: runningVersion }
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
        const created = await createBot(context.db, input)
        // The bot exists whether or not the computer can be reached; its screen starts with the server otherwise.
        await startScreen(context.db, context.screens, created).catch((error) =>
          console.error(`[screens] Couldn't start ${created.name}'s screen:`, error),
        )
        const bot = toBotInfo(created, { working: false, error: null })
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
        // Groups not renamed by the owner are named after their members.
        if (changes.name !== undefined) await publishGroupsOf(context, botId)
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
      // Its screen stops before its folder, with the browser profile in it, goes. If the computer can't be reached, the
      // screen is stopped when the server next starts.
      await context.screens.stop(bot).catch((error) => console.error(`[screens] Couldn't stop ${bot.name}'s screen:`, error))
      // Its pi history stays orphaned in pi-durable's storage, which can't delete a conversation yet; no bot reaches it.
      await context.runtime.forget(bot)
      await context.attachments.removeChat(bot.chatId)
      context.bus.publish({ type: 'bot.deleted', botId: bot.id, chatId: bot.chatId })
      for (const groupId of bot.leftGroups) await publishChat(context, groupId)
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

    memory: os.bots.memory.handler(async ({ context, input }) => {
      if (!(await getBot(context.db, input.botId))) throw new ORPCError('NOT_FOUND', { message: 'No such bot' })
      return (await listBotFacts(context.db, input.botId)).map(toFactInfo)
    }),
  },

  chats: {
    list: os.chats.list.handler(async ({ context }) => (await listChatSummaries(context.db)).map((summary) => chatInfoOf(context, summary))),

    read: os.chats.read.handler(async ({ context, input }) => {
      await chatMustExist(markChatRead(context.db, input.chatId, input.upTo))
      return (await publishChat(context, input.chatId))!
    }),

    setPinned: os.chats.setPinned.handler(async ({ context, input }) => {
      const changed = await chatMustExist(setPinnedChats(context.db, input.chatIds))
      const chats = (await listChatSummaries(context.db)).map((summary) => chatInfoOf(context, summary))
      for (const chat of chats) if (changed.includes(chat.id)) context.bus.publish({ type: 'chat.updated', chat })
      return chats
    }),

    messages: os.chats.messages.handler(async ({ context, input }) => {
      if (!(await getChat(context.db, input.chatId))) throw new ORPCError('NOT_FOUND', { message: 'No such chat' })
      return (await listMessages(context.db, input.chatId)).map(toMessageInfo)
    }),

    send: os.chats.send.handler(async ({ context, input }) => {
      const chat = await getChat(context.db, input.chatId)
      if (chat?.kind === 'group') return sendToGroup(context, chat.id, input.text, input.files)
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
      // The owner moved on: low-stakes questions they left unanswered are moot now.
      for (const dismissed of await dismissMovedOnQuestions(context.db, chat!.id, message.id)) {
        context.bus.publish({ type: 'message.updated', message: toMessageInfo(dismissed) })
      }
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

    dismiss: os.chats.dismiss.handler(async ({ context, input }) => {
      let dismissed
      try {
        dismissed = await dismissQuestion(context.db, input.messageId)
      } catch (error) {
        if (error instanceof QuestionNotFoundError) throw new ORPCError('NOT_FOUND', { message: error.message })
        if (error instanceof QuestionAnsweredError) throw new ORPCError('CONFLICT', { message: error.message })
        throw error
      }
      // The bot isn't woken: its next run lists the question as unanswered.
      const info = toMessageInfo(dismissed)
      context.bus.publish({ type: 'message.updated', message: info })
      await publishChat(context, dismissed.chatId)
      return info
    }),

    handBack: os.chats.handBack.handler(async ({ context, input }) => {
      const asked = await getMessage(context.db, input.messageId)
      const bot = asked?.authorBotId ? await getBot(context.db, asked.authorBotId) : undefined
      if (!asked?.card || !bot) throw new ORPCError('NOT_FOUND', { message: 'No such take-over' })
      await assertCanRun(context, bot)
      let handed
      try {
        handed = await handBack(context.db, input.messageId, input.outcome)
      } catch (error) {
        if (error instanceof TakeOverNotFoundError) throw new ORPCError('NOT_FOUND', { message: error.message })
        if (error instanceof HandedBackError) throw new ORPCError('CONFLICT', { message: error.message })
        throw error
      }
      const { message, card } = handed
      const info = toMessageInfo(message)
      context.bus.publish({ type: 'message.updated', message: info })
      await publishChat(context, message.chatId)
      try {
        await context.runtime.wake(bot.id, { lane: 'owner', text: describeHandBack(card, input.outcome), id: `hand-back:${message.id}` })
      } catch (error) {
        // A hand-back the bot never got isn't kept, so the owner can hand back again.
        const reopened = await reopenTakeOver(context.db, message.id)
        if (reopened) {
          context.bus.publish({ type: 'message.updated', message: toMessageInfo(reopened) })
          await publishChat(context, reopened.chatId)
        }
        throw error
      }
      return info
    }),
  },

  groups: {
    create: os.groups.create.handler(async ({ context, input }) => {
      for (const member of input.memberIds) await assertCanRun(context, await botMustExist(context, member))
      const chat = await membersMustFit(createGroup(context.db, { memberIds: input.memberIds }))
      const message = await sendToGroup(context, chat.id, input.text)
      return { chat: (await publishChat(context, chat.id))!, message }
    }),

    update: os.groups.update.handler(async ({ context, input }) => {
      await chatMustExist(membersMustFit(updateGroup(context.db, input.chatId, { title: input.title, memberIds: input.memberIds })))
      return (await publishChat(context, input.chatId))!
    }),

    delete: os.groups.delete.handler(async ({ context, input }) => {
      // Deleted first, so no turn can start or post in it while its rounds end.
      const chat = await deleteGroup(context.db, input.chatId)
      if (!chat) throw new ORPCError('NOT_FOUND', { message: 'No such group chat' })
      const ended = context.rounds.end(chat.id)
      await context.runtime.endGroupTurns(chat.id)
      await ended
      // Members keep what they said in their own histories (ADR 0001); only the chat's files go.
      await context.attachments.removeChat(chat.id)
      await context.computer
        .removeGroupFolder(chat.id)
        .catch((error) => console.error(`[groups] Couldn't delete the folder of group chat ${chat.id}:`, error))
      context.bus.publish({ type: 'chat.deleted', chatId: chat.id })
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

  general: {
    getSettings: os.general.getSettings.handler(async ({ context }) => ({ timeZone: await readTimeZone(context.db) })),

    updateSettings: os.general.updateSettings.handler(({ context, input }) => setTimeZone(context, () => writeTimeZone(context.db, input.timeZone))),

    detectTimeZone: os.general.detectTimeZone.handler(({ context, input }) => setTimeZone(context, () => detectTimeZone(context.db, input.timeZone))),
  },

  screens: {
    status: os.screens.status.handler(async ({ context, input }) => {
      const bot = await botMustExist(context, input.botId)
      const { state, startedAt } = await screenOf(context, bot)
      return { state, startedAt, ...screenSize }
    }),

    ticket: os.screens.ticket.handler(async ({ context, input }) => {
      const bot = await botMustExist(context, input.botId)
      const status = await screenOf(context, bot)
      if (status.state !== 'running' || status.streamPort === null) {
        const why = status.state === 'stopped' ? "isn't running" : status.state === 'crashed' ? 'is restarting' : 'is starting'
        throw new ORPCError('PRECONDITION_FAILED', { message: `${bot.name}'s screen ${why}` })
      }
      const { ticket, expiresAt } = context.screenTickets.issue(bot.id, status.streamPort)
      return { url: screenStreamUrl(bot.id, ticket), expiresAt }
    }),
  },

  orchestrator: {
    getModes: os.orchestrator.getModes.handler(({ context }) => readOrchestratorModes(context.db)),

    updateModes: os.orchestrator.updateModes.handler(({ context, input }) => writeOrchestratorModes(context.db, input)),
  },
})

export type Router = typeof router
