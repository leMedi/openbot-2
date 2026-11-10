import { type PushData, type PushKind, pushKinds } from '@openbot/api-contract'

/** A notification's `data` as the instance sends it (#106), or undefined for one that isn't OpenBot's. */
export function pushDataOf(data: unknown): PushData | undefined {
  if (!data || typeof data !== 'object') return undefined
  const { chatId, messageId, kind, botId, botName, group, quiet } = data as Record<string, unknown>
  if (typeof chatId !== 'string' || typeof messageId !== 'string' || !pushKinds.includes(kind as PushKind)) return undefined
  return {
    chatId,
    messageId,
    kind: kind as PushKind,
    botId: typeof botId === 'string' ? botId : '',
    botName: typeof botName === 'string' ? botName : '',
    group: group === true,
    quiet: quiet === true,
  }
}
