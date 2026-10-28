import { type Db, type Message, messages } from '@openbot/db'
import { and, isNull, sql } from 'drizzle-orm'

/**
 * A Reconnect card's payload, as stored in `messages.card`: a plugin account the bot is granted needs reconnecting, as
 * its sign-in expired and couldn't be refreshed (design §5.5). The owner signs in again from it, or from Settings → Plugins.
 */
export type PluginReconnectCard = {
  type: 'plugin_reconnect'
  /** The plugin's catalog name. */
  plugin: string
  /** Its display name then, e.g. Notion. */
  displayName: string
  /** The account, named as it was then. */
  account: { slug: string; displayName: string }
}

/** How the card was closed: the account reconnected, or disconnected instead. */
export type PluginReconnectOutcome = 'reconnected' | 'disconnected'

/** How the card was closed, as stored in `messages.card_state`; absent while it waits. */
type PluginReconnectState = { outcome: PluginReconnectOutcome }

export function isPluginReconnectCard(card: unknown): card is PluginReconnectCard {
  return typeof card === 'object' && card !== null && (card as { type?: unknown }).type === 'plugin_reconnect'
}

/** How the card was closed, or null while it waits. */
export const pluginReconnectOutcomeOf = (message: Pick<Message, 'cardState'>): PluginReconnectOutcome | null =>
  (message.cardState as PluginReconnectState | null)?.outcome ?? null

/** What the card's message says, e.g. in the sidebar while it waits: "Notion (Work) needs reconnecting". */
export const describePluginReconnect = (card: PluginReconnectCard) => `${card.displayName} (${card.account.displayName}) needs reconnecting: its sign-in expired`

/** Closes every waiting Reconnect card of the account once it is reconnected or disconnected; returns their messages. */
export function closePluginReconnects(db: Db, plugin: string, slug: string, outcome: PluginReconnectOutcome): Promise<Message[]> {
  return db
    .update(messages)
    .set({ cardState: { outcome } satisfies PluginReconnectState })
    .where(
      and(
        sql`json_extract(${messages.card}, '$.type') = 'plugin_reconnect'`,
        sql`json_extract(${messages.card}, '$.plugin') = ${plugin}`,
        sql`json_extract(${messages.card}, '$.account.slug') = ${slug}`,
        isNull(messages.cardState),
      ),
    )
    .returning()
}
