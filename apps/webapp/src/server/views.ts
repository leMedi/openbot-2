import { type AuditEntryInfo, type BotInfo, type CardInfo, type ChatInfo, deletedAuthorName, type MessageInfo } from '@openbot/api-contract'
import type { BotStatus } from '@openbot/agent'
import { type BotWithChat, type ChatSummary, handBackOutcomeOf, isQuestionCard, isTakeOverCard, questionAnswerOf } from '@openbot/core'
import type { AuditEntry, Message } from '@openbot/db'

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
  if (isQuestionCard(message.card)) return { ...message.card, answer: questionAnswerOf(message) }
  // The goal is the bot's, for when it goes on; the owner sees the instruction.
  if (isTakeOverCard(message.card)) return { type: 'take_over', instruction: message.card.instruction, outcome: handBackOutcomeOf(message) }
  return null
}

/** What the sidebar shows of a chat; its newest message is cut down to a preview. */
export function toChatInfo(chat: ChatSummary): ChatInfo {
  const last = chat.lastMessage && toMessageInfo(chat.lastMessage)
  return {
    id: chat.id,
    kind: chat.kind,
    botId: chat.botId,
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
    surface: entry.surface,
    tool: entry.tool,
    input: entry.action,
    verdict: entry.verdict,
    mode: entry.mode,
    createdAt: entry.createdAt.getTime(),
  }
}
