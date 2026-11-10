/**
 * The keys this app keeps in expo-sqlite's key–value store, besides LiveStore's drafts (`openbot.draft.<chatId>`).
 * Everything there belongs to the instance and goes when the phone leaves it, except `phoneKeys`.
 */

/** The instance this phone connects to. */
export const instanceKey = 'openbot.instance'
/** Set once iOS's Local Network prompt was waited for, so a later denial says so at once. */
export const localNetworkAskedKey = 'openbot.localNetworkAsked'
/** The Chats list's folded sections. */
export const foldsKey = 'openbot.chats.folds'

/** What belongs to the phone rather than to an instance, kept when it disconnects or moves to another. */
export const phoneKeys: readonly string[] = [localNetworkAskedKey]
