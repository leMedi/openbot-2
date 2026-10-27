import type { AuditEntryInfo, BotInfo, MessageInfo } from '@openbot/api-contract'
import type { BotStatus } from '@openbot/agent'
import type { BotWithChat } from '@openbot/core'
import type { AuditEntry, Message } from '@openbot/db'

/** What the API shows of a message: never its tool call's idempotency key. */
export function toMessageInfo(message: Message): MessageInfo {
  return {
    id: message.id,
    chatId: message.chatId,
    author: message.author,
    botId: message.authorBotId,
    authorName: message.authorName,
    text: message.text,
    createdAt: message.createdAt.getTime(),
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
