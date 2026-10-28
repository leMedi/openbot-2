import type { PluginInfo } from '@openbot/api-contract'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { PluginIcon, PluginStatus } from '../../components/plugins.tsx'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/plugins/')({
  component: Plugins,
})

/** Settings → Plugins: the catalog bundled with this release, each plugin with its status, opening its detail view. */
function Plugins() {
  const [plugins, setPlugins] = useState<PluginInfo[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api().plugins.list().then(setPlugins, (caught) => setError(errorMessage(caught)))
  }, [])

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-xl font-semibold">Plugins</h2>
        <p className="text-base text-muted-foreground">
          Services your bots can use through their own tools, signed in with your accounts. A bot uses a plugin only once you grant it.
        </p>
      </header>

      {error && <p className="text-destructive-foreground">Couldn't load plugins: {error}</p>}
      {!plugins && !error && <p className="text-muted-foreground">Loading…</p>}
      {plugins?.length === 0 && <p className="text-muted-foreground">This release has no plugins.</p>}

      {plugins && plugins.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
          {plugins.map((plugin) => (
            <li key={plugin.name}>
              <Link
                to="/settings/plugins/$name"
                params={{ name: plugin.name }}
                className="flex items-center gap-3 px-4 py-3 transition-colors duration-100 hover:bg-secondary-hover"
              >
                <PluginIcon plugin={plugin} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-lg font-medium">{plugin.displayName}</span>
                  <span className="truncate text-sm text-muted-foreground">{plugin.description}</span>
                </span>
                <PluginStatus status={plugin.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
