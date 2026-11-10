import type { PluginInfo } from '@openbot/api-contract'

/** The plugins most owners connect first, in this order. */
const popular = ['notion', 'linear', 'atlassian', 'airtable', 'clickup', 'monday', 'todoist', 'granola', 'stripe', 'zapier', 'miro', 'exa']

export type PluginSection = { title: 'Connected' | 'Popular' | 'Other'; plugins: PluginInfo[] }

/**
 * The catalog as Settings → Plugins lists it, in the web and on the phone: those matching every word of `query` (in
 * their name, description or keywords), connected plugins first by name, then the popular ones, then the rest by
 * name, leaving out empty sections.
 */
export function pluginSections(plugins: readonly PluginInfo[], query: string): PluginSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = plugins.filter((plugin) => {
    const text = [plugin.displayName, plugin.name, plugin.description, ...plugin.keywords].join(' ').toLowerCase()
    return words.every((word) => text.includes(word))
  })
  const connected = shown.filter((plugin) => plugin.status !== 'not_connected')
  const rest = shown.filter((plugin) => plugin.status === 'not_connected')
  const byName = (a: PluginInfo, b: PluginInfo) => a.displayName.localeCompare(b.displayName)
  const sections: PluginSection[] = [
    { title: 'Connected', plugins: connected.sort(byName) },
    { title: 'Popular', plugins: rest.filter((plugin) => popular.includes(plugin.name)).sort((a, b) => popular.indexOf(a.name) - popular.indexOf(b.name)) },
    { title: 'Other', plugins: rest.filter((plugin) => !popular.includes(plugin.name)).sort(byName) },
  ]
  return sections.filter((section) => section.plugins.length > 0)
}

/** What a plugin's status is called, in its list and detail view. */
export const pluginStatusLabels: Record<PluginInfo['status'], string> = {
  not_connected: 'Not connected',
  connected: 'Connected',
  needs_reconnect: 'Needs reconnect',
}
