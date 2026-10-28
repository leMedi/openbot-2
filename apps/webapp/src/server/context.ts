import { join } from 'node:path'
import { type BotComputer, BotRuntime, type BotRuntimeOptions, type BotTool, type ConnectablePlugin, type ModelProvider, PluginAccounts, Providers, type Watchdog } from '@openbot/agent'
import type { ChatInfo, LiveEvent } from '@openbot/api-contract'
import {
  AllowAllOrchestrator,
  type AttachmentFile,
  AttachmentStore,
  type BotWithChat,
  type ChatSummary,
  describePluginReconnect,
  describePluginRequest,
  type PluginReconnectCard,
  describeRoutineChange,
  type Clock,
  instantAt,
  type LocalDateTime,
  ownerTimeZone,
  type Browser,
  type Desktop,
  EventBus,
  getChatSummary,
  GroupRounds,
  type Orchestrator,
  postMessage,
  type Screens,
  SecretBox,
  ServerJobs,
  systemClock,
  keepScreensInSync,
  MemoryConsolidation,
  MemoryExtraction,
  readModelSettings,
  Routines,
  getBot,
} from '@openbot/core'
import type { Db } from '@openbot/db'
import { installedSkillFile, installSkills, loadCatalog, type Plugin } from '@openbot/plugins'
import type { ScreenTickets } from './screen-stream.ts'
import { toChatInfo, toMessageInfo, toRoutineInfo, toRoutineRunInfo } from './views.ts'

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
  /** Stops bringing the bots' screens back when the screen daemon restarts; when the server stops. */
  stopSyncingScreens(): void
  /** Plays group chats' rounds of member turns. */
  rounds: GroupRounds
  /**
   * The server's time: its scheduled jobs wait on it, and so tests can move it, timestamps new server code writes
   * (e.g. memory facts') should read it. Older writes and pi-durable's entries still read the system's time.
   */
  clock: Clock
  /**
   * The server's scheduled jobs, e.g. memory consolidation; `jobs.close()` stops them. They are rescheduled whenever
   * the owner's time zone changes.
   */
  jobs: ServerJobs
  /** The owner's time, as scheduled jobs (routines, memory consolidation) read it. */
  ownerTime: OwnerTime
  /** Memory extraction after bots' runs; `extraction.close()` stops it. */
  extraction: MemoryExtraction
  /** Bots' routines, fired on the server's clock; `routines.close()` stops them. */
  routines: Routines
  /** The plugin catalog, read once on boot, by name. */
  plugins: Plugin[]
  /** The owner's plugin accounts, their sign-ins, grants and connections; `pluginAccounts.close()` closes those. */
  pluginAccounts: PluginAccounts
}

/** The owner's time zone (`settings.timeZone`), as scheduled jobs read it. */
export type OwnerTime = {
  /** The owner's IANA time zone, or UTC until the web app detects it; a `DailyJob`'s `timeZone`. */
  timeZone(): Promise<string>
  /** The instant when the owner's clocks read `local`, e.g. a reminder's `2026-10-29T09:00`. */
  instant(local: LocalDateTime): Promise<number>
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
  botTools,
  watchdog,
  fetch,
  compaction,
  clock = systemClock,
  memoryExtraction = true,
  memoryConsolidation = true,
  catalog,
  home,
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
  /**
   * The tools only some bots have, deferred until each bot loads them with tool_search: the plugin accounts' tools each
   * bot is granted, or a test's.
   */
  botTools?: BotRuntimeOptions['botTools']
  /** When a run the owner's message waits for is interrupted again, then detached; Grok's timings by default. */
  watchdog?: Watchdog
  /** Downloads the https:// images bots send each other; the global `fetch` by default. */
  fetch?: typeof globalThis.fetch
  /** When and how much bots' histories are compacted; pi-durable's defaults otherwise. */
  compaction?: BotRuntimeOptions['compaction']
  /** The server's time; the system's by default, a fake one tests move forward. */
  clock?: Clock
  /** Extracts memory after every run of a bot (design §5.3); tests leave it off unless they script the memory model. */
  memoryExtraction?: boolean
  /** Consolidates memory nightly (design §5.3); tests leave it off unless they script the memory model. */
  memoryConsolidation?: boolean
  /** The plugin catalog's folder: the release's, or a test's fixture. */
  catalog: string
  /** The bots' home, where plugins' skills are copied for them to read. */
  home: string
}): Promise<ServerContext> {
  const bus = new EventBus<LiveEvent>()
  const pluginsDir = join(home, 'plugins')
  const plugins = await openCatalog(catalog, pluginsDir)
  const attachments = new AttachmentStore(attachmentsDir)
  const box = new SecretBox(secretKey)
  const providers = new Providers({ db, box, providers: modelProviders })
  const pluginAccounts = new PluginAccounts({
    db,
    box,
    plugins: connectable(plugins),
    // One Reconnect card in the DM of each bot granted the account, whose sign-in expired: once per expiry, as it is told
    // again when another bot is granted it.
    async onNeedsReconnect({ plugin: name, slug, displayName, needsReconnectAt, grantedTo }) {
      const plugin = plugins.find((entry) => entry.name === name)
      const card: PluginReconnectCard = { type: 'plugin_reconnect', plugin: name, displayName: plugin?.displayName ?? name, account: { slug, displayName } }
      for (const botId of grantedTo) {
        const bot = await getBot(db, botId)
        if (bot) await postCard(bot, card, describePluginReconnect(card), `plugin-reconnect:${name}:${slug}:${needsReconnectAt?.getTime()}:${botId}`)
      }
    },
  })
  // Made before the runtime, whose resumed runs may post to groups as it opens; turns wait for it to be open.
  let opened!: (runtime: BotRuntime) => void
  const runtimeOpen = new Promise<BotRuntime>((resolve) => (opened = resolve))
  const rounds = new GroupRounds({
    db,
    takeTurn: async (botId, input) => (await runtimeOpen).takeTurn(botId, input),
    onSpeaking: (chatId) => void publish(chatId).catch((error) => console.error("[groups] Couldn't show who is taking a turn:", error)),
  })
  const publish = (chatId: string) => publishChat({ db, bus, rounds }, chatId)
  const memoryModelOptions = {
    db,
    clock,
    // The memory model, else the default; none while its provider isn't connected.
    model: async () => {
      const { memoryModel, defaultModel } = await readModelSettings(db)
      const ref = memoryModel ?? defaultModel
      return ref && (await providers.findModel(ref)) ? ref : undefined
    },
    complete: (ref: string, request: { systemPrompt: string; prompt: string }) => providers.complete(ref, request),
  }
  const extraction = new MemoryExtraction(memoryModelOptions)
  const ownerTime: OwnerTime = {
    timeZone: () => ownerTimeZone(db),
    instant: async (local) => instantAt(local, await ownerTimeZone(db)),
  }
  // Made before the runtime, which tells it how the routine runs it resumes end; it starts firing once the runtime is open.
  let openRuntime: BotRuntime | undefined
  const routines = new Routines({
    db,
    clock,
    timeZone: ownerTime.timeZone,
    wake: async (botId, input) => (await runtimeOpen).wake(botId, input),
    pending: (botId, inputId) => openRuntime?.pending(botId, inputId) ?? false,
    onRoutine: (routine) => bus.publish({ type: 'routine.updated', routine: toRoutineInfo(routine) }),
    onRoutineDeleted: (routine) => bus.publish({ type: 'routine.deleted', botId: routine.botId, routineId: routine.id }),
    onRun: async (routine, run) => {
      const bot = await getBot(db, routine.botId)
      if (bot) bus.publish({ type: 'routineRun.updated', botId: bot.id, run: toRoutineRunInfo(run, bot.chatId) })
    },
  })
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
  /** Posts a bot's card (a question, a take-over, a plugin request or reconnect, a routine change) to its DM, once per idempotency key. */
  async function postCard(bot: BotWithChat, card: object, text: string, idempotencyKey: string) {
    const { message, created } = await postMessage(db, { chatId: bot.chatId, author: 'bot', authorBotId: bot.id, authorName: bot.name, text, card, idempotencyKey })
    if (!created) return
    bus.publish({ type: 'message.created', message: toMessageInfo(message) })
    await publish(bot.chatId)
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
    botTools: botTools ?? ((botId) => pluginAccounts.botTools(botId)),
    // The skills of every plugin the bot is granted, read from the copies in the bots' home.
    botSkills: async (botId) =>
      (await pluginAccounts.grantedPlugins(botId)).flatMap((name) =>
        (plugins.find((plugin) => plugin.name === name)?.skills ?? []).map((skill) => ({
          name: skill.name,
          description: skill.description,
          filePath: installedSkillFile(pluginsDir, name, skill),
        })),
      ),
    searchPlugins: (botId) =>
      pluginAccounts.listings(
        botId,
        plugins.map(({ name, displayName, description, servers }) => ({ name, displayName, description, skillsOnly: !servers.length })),
      ),
    watchdog,
    fetch,
    compaction,
    clock,
    routines,
    ...(memoryExtraction && { onRunSettled: (botId, exchange) => extraction.extract(botId, exchange) }),
    async sendMessage(bot, chatId, { text, attachments: files }, idempotencyKey, inputId) {
      const message = await postBotMessage(bot, chatId, text, files, idempotencyKey)
      // A routine's run links the first message it sent the owner.
      if (message && chatId === bot.chatId) await routines.sentMessage(inputId, message.id)
    },
    async messageGroup(sender, group, { text }, idempotencyKey) {
      const message = await postBotMessage(sender, group.id, text, [], idempotencyKey)
      // The other members answer it in rounds, as they answer the owner; rounds going on read it in their turns.
      if (message) void rounds.startUnlessPlaying(group.id, message)
    },
    async messageBot(sender, recipient, { text, attachments: files }, idempotencyKey) {
      // One entry in each DM, each with its own copies of the images: either DM can go with its bot.
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
    askQuestion(bot, card, idempotencyKey) {
      // The prompt doubles as the message's text, e.g. for previews.
      return postCard(bot, card, card.prompt, idempotencyKey)
    },
    requestPlugin(bot, card, idempotencyKey) {
      // "Wants to use Notion: <reason>" doubles as the message's text, e.g. for previews.
      return postCard(bot, card, describePluginRequest(card), idempotencyKey)
    },
    postRoutineChange(bot, card, idempotencyKey) {
      // The row's sentence doubles as the message's text, e.g. for previews.
      return postCard(bot, card, describeRoutineChange(bot.name, card), idempotencyKey)
    },
    requestTakeOver(bot, card, idempotencyKey) {
      // The instruction doubles as the message's text, e.g. for previews.
      return postCard(bot, card, card.instruction, idempotencyKey)
    },
    onStatus: (botId, status) => bus.publish({ type: 'bot.status', botId, ...status }),
    onInputSettled: (_botId, inputId, outcome) =>
      void routines.settled(inputId, outcome).catch((error) => console.error("[routines] Couldn't record how a run ended:", error)),
  })
  openRuntime = runtime
  opened(runtime)
  const { synced: screensSynced, stop: stopSyncingScreens } = keepScreensInSync(db, screens)
  const jobs = new ServerJobs({ clock })
  bus.listen(({ event }) => {
    if (event.type !== 'timeZone.updated') return
    void jobs.reschedule()
    void routines.reschedule().catch((error) => console.error("[routines] Couldn't reschedule routines:", error))
  })
  await routines.start()
  if (memoryConsolidation) {
    const consolidation = new MemoryConsolidation(memoryModelOptions)
    jobs.daily('memory consolidation', { at: '04:00', timeZone: ownerTime.timeZone }, () => consolidation.run())
  }
  return {
    db,
    bus,
    providers,
    runtime,
    computer,
    attachments,
    screens,
    screenTickets,
    screensSynced,
    stopSyncingScreens,
    rounds,
    clock,
    jobs,
    ownerTime,
    extraction,
    routines,
    plugins,
    pluginAccounts,
  }
}

/** The catalog's plugins whose accounts bots can call: those with one server (OpenBot can't sign in to several yet). */
const connectable = (plugins: Plugin[]): ConnectablePlugin[] =>
  plugins.flatMap(({ name, displayName, servers: [server, ...more] }) => (server && !more.length ? [{ name, displayName, serverUrl: server.url }] : []))

/**
 * The catalog's plugins, with what the loader refused or ignored logged, and their skills copied into `pluginsDir` in
 * the bots' home, replacing the copies of an earlier release. Bots go without skills, rather than the server failing to start, when
 * they can't be copied.
 */
async function openCatalog(catalog: string, pluginsDir: string): Promise<Plugin[]> {
  const { plugins, problems } = await loadCatalog(catalog)
  for (const problem of problems) console.warn(`[plugins] ${problem}`)
  await installSkills(plugins, pluginsDir).catch((error) => console.error("[plugins] Couldn't copy plugins' skills for bots:", error))
  return plugins
}
