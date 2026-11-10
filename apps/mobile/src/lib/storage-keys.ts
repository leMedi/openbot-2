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
/** LiveStore's snapshot of the instance's chats and loaded messages, shown while it can't be reached. */
export const snapshotKey = 'openbot.snapshot'
/** Set once the Screen's "Turn sideways" hint was shown: a tip about the phone, kept as the phone's own. */
export const turnHintKey = 'openbot.screen.turnHintShown'
/**
 * The voice model's download while it's under way, with whether it may use cellular data, so it carries on after a
 * restart. The model itself is a file in the app's documents; both belong to the phone, not to an instance.
 */
export const dictationDownloadKey = 'openbot.dictation.download'
/** Android: the id of the voice model's download in the system's DownloadManager, which outlives the app. */
export const systemDownloadKey = 'openbot.dictation.systemDownload'

/** What belongs to the phone rather than to an instance, kept when it disconnects or moves to another. */
export const phoneKeys: readonly string[] = [localNetworkAskedKey, turnHintKey, dictationDownloadKey, systemDownloadKey]
