import type { BotInfo, ChatInfo } from '@openbot/api-contract'

/** A group chat's members as bots, in turn order; deleted ones are gone. */
export function membersOf(chat: ChatInfo, bots: readonly BotInfo[] | undefined): BotInfo[] {
  return chat.members.flatMap((id) => bots?.find((bot) => bot.id === id) ?? [])
}
