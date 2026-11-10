import type { PluginInfo } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { pluginSections } from './plugins.ts'

function plugin(name: string, displayName: string, changes: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name,
    displayName,
    version: null,
    description: '',
    keywords: [],
    icon: null,
    status: 'not_connected',
    servers: [{ name, url: `https://mcp.${name}.com` }],
    skills: [],
    accounts: [],
    grantedTo: [],
    ...changes,
  }
}

const catalog = [
  plugin('zapier', 'Zapier'),
  plugin('acme', 'Acme'),
  plugin('linear', 'Linear', { keywords: ['tickets', 'issues'] }),
  plugin('notion', 'Notion', { description: 'Pages and databases' }),
  plugin('clickup', 'ClickUp', { status: 'connected' }),
  plugin('asana', 'Asana', { status: 'needs_reconnect' }),
  plugin('box', 'Box'),
]

const names = (sections: ReturnType<typeof pluginSections>) => sections.map((section) => [section.title, section.plugins.map((each) => each.name)])

describe('the plugin catalog as Settings → Plugins lists it', () => {
  it('lists connected plugins by name, then the popular ones in their order, then the rest by name', () => {
    expect(names(pluginSections(catalog, ''))).toEqual([
      ['Connected', ['asana', 'clickup']],
      ['Popular', ['notion', 'linear', 'zapier']],
      ['Other', ['acme', 'box']],
    ])
  })

  it('finds plugins by every word of the query, in their name, description or keywords, leaving out empty sections', () => {
    expect(names(pluginSections(catalog, 'TICKETS'))).toEqual([['Popular', ['linear']]])
    expect(names(pluginSections(catalog, 'pages data'))).toEqual([['Popular', ['notion']]])
    expect(names(pluginSections(catalog, 'pages tickets'))).toEqual([])
  })
})
