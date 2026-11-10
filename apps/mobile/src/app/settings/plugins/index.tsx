import { pluginSections, pluginStatusLabels } from '@openbot/client'
import { router, Stack } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Group, GroupedScroll, Loading, Note, Row } from '../../../components/grouped.tsx'
import { PluginIcon } from '../../../components/plugin-icon.tsx'
import { SearchField } from '../../../components/search-field.tsx'
import { useInstance } from '../../../lib/instance-context.ts'
import { useLoadOnFocus } from '../../../lib/use-load.ts'

/**
 * Settings → Plugins, as the web's: the catalog bundled with the instance, searchable, connected plugins first, then
 * the popular ones, then the rest; each opens its own screen.
 */
export default function Plugins() {
  const { api } = useInstance()
  const plugins = useLoadOnFocus(useCallback(() => api.plugins.list(), [api]))
  const [query, setQuery] = useState('')
  const sections = useMemo(() => pluginSections(plugins.data ?? [], query), [plugins.data, query])

  return (
    <>
      <Stack.Screen options={{ title: 'Plugins' }} />
      <GroupedScroll keyboardDismissMode="on-drag">
        <Note>Services your bots can use through their own tools, signed in with your accounts. A bot uses a plugin only once you grant it.</Note>
        {plugins.error && !plugins.data && <Note tone="error">{`Couldn't load plugins: ${plugins.error}`}</Note>}
        {!plugins.data && !plugins.error && <Loading />}
        {plugins.data?.length === 0 && <Note>This release has no plugins.</Note>}
        {!!plugins.data?.length && (
          <SearchField
            query={query}
            searching={false}
            onQuery={setQuery}
            onSearching={() => {}}
            placeholder={`Search ${plugins.data.length} plugins`}
            label="Search plugins"
            inset={false}
          />
        )}
        {!!plugins.data?.length && !sections.length && <Note>{`No plugin matches “${query.trim()}”.`}</Note>}
        {sections.map((section) => (
          <Group key={section.title} label={section.title}>
            {section.plugins.map((plugin) => (
              <Row
                key={plugin.name}
                icon={<PluginIcon plugin={plugin} />}
                label={plugin.displayName}
                detail={plugin.description}
                value={plugin.status === 'not_connected' ? undefined : pluginStatusLabels[plugin.status]}
                onPress={() => router.push({ pathname: '/settings/plugins/[name]', params: { name: plugin.name } })}
              />
            ))}
          </Group>
        ))}
      </GroupedScroll>
    </>
  )
}
