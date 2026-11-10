import type { PluginInfo } from '@openbot/api-contract'
import { pluginSections } from '@openbot/client'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { PluginIcon, PluginStatus } from '../../components/plugins.tsx'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/plugins/')({
  component: Plugins,
})

/**
 * Settings → Plugins: the catalog bundled with this release, searchable, connected plugins first, then the popular
 * ones, then the rest by name; each with its status, opening its detail view.
 */
function Plugins() {
  const [plugins, setPlugins] = useState<PluginInfo[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')

  useEffect(() => {
    api().plugins.list().then(setPlugins, (caught) => setError(errorMessage(caught)))
  }, [])

  const sections = useMemo(() => pluginSections(plugins ?? [], query), [plugins, query])

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
        <div className="relative">
          <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground">
            <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            aria-label="Search plugins"
            placeholder={`Search ${plugins.length} plugins`}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-lg border border-input bg-input-fill py-2 pr-3 pl-8.5 text-lg outline-offset-0 placeholder:text-muted-foreground"
          />
        </div>
      )}
      {plugins && plugins.length > 0 && !sections.length && <p className="text-muted-foreground">No plugin matches “{query.trim()}”.</p>}

      {sections.map((section) => (
        <div key={section.title} role="group" aria-labelledby={`plugins-${section.title}`} className="flex flex-col gap-1.5">
          <h3 id={`plugins-${section.title}`} className="text-sm font-medium text-muted-foreground">
            {section.title}
          </h3>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
            {section.plugins.map((plugin) => (
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
        </div>
      ))}
    </section>
  )
}
