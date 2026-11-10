import { type BotInfo, type ChatInfo, maxGroupMembers } from '@openbot/api-contract'

/** A group chat's members as bots, in turn order; deleted ones are gone. */
export function membersOf(chat: ChatInfo, bots: readonly BotInfo[] | undefined): BotInfo[] {
  return chat.members.flatMap((id) => bots?.find((bot) => bot.id === id) ?? [])
}

/**
 * The bots a group chat of `members` can take, as the "To:" field and Add member offer them: those not in it yet whose
 * name has `query` (ignoring case and a leading @), in `bots`' order; none once it has the most members it can have.
 */
export function groupCandidates(bots: readonly BotInfo[], members: readonly Pick<BotInfo, 'id'>[], query: string): BotInfo[] {
  if (members.length >= maxGroupMembers) return []
  return bots.filter((bot) => !members.some((member) => member.id === bot.id) && nameMatches(bot, query))
}

/** Whether `bot`'s name has what was typed in a "To:" field, ignoring case and a leading @. */
export function nameMatches(bot: Pick<BotInfo, 'name'>, query: string): boolean {
  return bot.name.toLowerCase().includes(query.trim().toLowerCase().replace(/^@/, ''))
}
