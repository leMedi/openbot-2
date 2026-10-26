import type { BotInfo, MessageInfo } from '@openbot/api-contract'
import type { BotStatus } from '@openbot/agent'
import type { BotWithChat } from '@openbot/core'
import type { Message } from '@openbot/db'

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
    handle: bot.handle,
    name: bot.name,
    title: bot.title,
    persona: bot.persona,
    avatarShape: bot.avatarShape,
    avatarColor: bot.avatarColor as BotInfo['avatarColor'],
    model: bot.model,
    chatId: bot.chatId,
    working,
    error,
  }
}
