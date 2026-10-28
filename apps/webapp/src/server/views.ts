import { type AuditEntryInfo, type BotInfo, type CardInfo, type ChatInfo, type FactInfo, deletedAuthorName, type MessageInfo, type PluginAccountInfo, type PluginInfo, pluginIconPath, type RoutineInfo, type RoutineRunInfo } from '@openbot/api-contract'
import type { BotStatus, PluginAccountSummary } from '@openbot/agent'
import { type BotWithChat, type ChatSummary, type RoutineState, factSourceName, handBackOutcomeOf, isPluginRequestCard, isQuestionCard, pluginRequestDecisionOf, isRoutineChangeCard, isTakeOverCard, questionAnswerOf, questionDismissedOf } from '@openbot/core'
import type { AuditEntry, Fact, Message, RoutineRun } from '@openbot/db'
import type { Plugin } from '@openbot/plugins'

/**
 * What the API shows of a message: never its tool call's idempotency key. A bot's message whose bot was deleted keeps
 * its name, shown as "Name (deleted)" (ADR 0009).
 */
export function toMessageInfo(message: Message): MessageInfo {
  return {
    id: message.id,
    chatId: message.chatId,
    author: message.author,
    botId: message.authorBotId,
    authorName: message.author === 'bot' && !message.authorBotId ? deletedAuthorName(message.authorName) : message.authorName,
    text: message.text,
    attachments: message.attachments,
    card: toCardInfo(message),
    botMessage: message.direction && {
      direction: message.direction,
      botId: message.peerBotId,
      name: message.peerBotId ? message.peerName! : deletedAuthorName(message.peerName!),
    },
    createdAt: message.createdAt.getTime(),
  }
}

/** A message's card with its answer or outcome, or null when it is no card. */
function toCardInfo(message: Message): CardInfo | null {
  if (isQuestionCard(message.card)) return { ...message.card, answer: questionAnswerOf(message), dismissed: questionDismissedOf(message) }
  // The goal is the bot's, for when it goes on; the owner sees the instruction.
  if (isTakeOverCard(message.card)) return { type: 'take_over', instruction: message.card.instruction, outcome: handBackOutcomeOf(message) }
  if (isPluginRequestCard(message.card)) return { ...message.card, decision: pluginRequestDecisionOf(message) }
  if (isRoutineChangeCard(message.card)) return { type: 'routine_change', change: message.card.change, routineId: message.card.routineId, name: message.card.name }
  return null
}

/** What the sidebar shows of a chat, with the member taking its turn in a group; its newest message is cut down to a preview. */
export function toChatInfo(chat: ChatSummary, speaking: string | null): ChatInfo {
  const last = chat.lastMessage && toMessageInfo(chat.lastMessage)
  return {
    id: chat.id,
    kind: chat.kind,
    botId: chat.botId,
    name: chat.name,
    title: chat.kind === 'group' ? chat.title : null,
    members: chat.members,
    speaking,
    pinnedPosition: chat.pinnedPosition,
    unread: chat.unread,
    waitingFor: chat.waitingFor,
    lastMessage: last && {
      author: last.author,
      authorName: last.authorName,
      text: last.text,
      attachments: last.attachments,
      botMessage: last.botMessage,
      createdAt: last.createdAt,
    },
  }
}

export function toBotInfo(bot: BotWithChat, { working, error }: BotStatus): BotInfo {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    instructions: bot.instructions,
    avatarShape: bot.avatarShape,
    avatarColor: bot.avatarColor as BotInfo['avatarColor'],
    model: bot.model,
    chatId: bot.chatId,
    working,
    error,
  }
}

export function toAuditEntryInfo(entry: AuditEntry): AuditEntryInfo {
  return {
    id: entry.id,
    botId: entry.botId,
    kind: entry.kind,
    surface: entry.surface,
    tool: entry.tool,
    server: entry.server,
    input: entry.action,
    verdict: entry.verdict,
    mode: entry.mode,
    outcome: entry.outcome,
    createdAt: entry.createdAt.getTime(),
  }
}

/** A fact as the owner sees it in a bot's Memory pane or Settings → Shared memory; its writer shown as deleted once it is. */
export function toFactInfo(fact: Fact): FactInfo {
  return {
    id: fact.id,
    tier: fact.tier,
    content: fact.content,
    importance: fact.importance,
    source: fact.source,
    sourceBotName: fact.source === 'bot' ? factSourceName(fact) : null,
    createdAt: fact.createdAt.getTime(),
    updatedAt: fact.updatedAt.getTime(),
  }
}

/** What the Routines pane shows of a routine. */
export function toRoutineInfo(routine: RoutineState): RoutineInfo {
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    prompt: routine.prompt,
    schedule: routine.schedule,
    enabled: routine.enabled,
    nextRunAt: routine.nextRunAt?.getTime() ?? null,
    createdBy: routine.createdBy,
    running: routine.running,
    createdAt: routine.createdAt.getTime(),
    updatedAt: routine.updatedAt.getTime(),
  }
}

/** A run in a routine's history, its message linked in the bot's DM `chatId`. */
export function toRoutineRunInfo(run: RoutineRun, chatId: string): RoutineRunInfo {
  return {
    id: run.id,
    routineId: run.routineId,
    scheduledFor: run.scheduledFor.getTime(),
    firedAt: run.firedAt?.getTime() ?? null,
    status: run.status,
    finishedAt: run.finishedAt?.getTime() ?? null,
    message: run.messageId ? { id: run.messageId, chatId } : null,
    test: run.test,
  }
}

/**
 * What the owner sees of a catalog plugin, with its accounts (any plugin's may be passed), connected once it has one, and
 * the bots granted it without an account, by plugin.
 */
export function toPluginInfo(plugin: Plugin, accounts: PluginAccountSummary[], grantedWithoutAccount: Map<string, string[]>): PluginInfo {
  const own = accounts.filter((account) => account.plugin === plugin.name).map(toPluginAccountInfo)
  return {
    name: plugin.name,
    displayName: plugin.displayName,
    version: plugin.version,
    description: plugin.description,
    icon: plugin.icon && pluginIconPath(plugin.name),
    status: own.length ? 'connected' : 'not_connected',
    servers: plugin.servers,
    skills: plugin.skills.map(({ name, description }) => ({ name, description })),
    accounts: own,
    grantedTo: grantedWithoutAccount.get(plugin.name) ?? [],
  }
}

/** What the owner sees of a plugin account: never its tokens. */
export function toPluginAccountInfo(account: PluginAccountSummary): PluginAccountInfo {
  return { slug: account.slug, displayName: account.displayName, connectedAt: account.connectedAt.getTime(), grantedTo: account.grantedTo }
}
