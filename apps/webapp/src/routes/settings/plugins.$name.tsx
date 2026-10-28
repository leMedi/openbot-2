import type { PluginInfo } from '@openbot/api-contract'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { PluginIcon, PluginStatus } from '../../components/plugins.tsx'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/plugins/$name')({
  component: PluginDetail,
})

/** A plugin's detail view in Settings → Plugins: what it is, its status, and the servers and skills it brings. */
function PluginDetail() {
  const { name } = Route.useParams()
  const [plugin, setPlugin] = useState<PluginInfo>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    setPlugin(undefined)
    setError(undefined)
    api().plugins.get({ name }).then(setPlugin, (caught) => setError(errorMessage(caught)))
  }, [name])

  return (
    <section className="flex flex-col gap-6">
      <Link
        to="/settings/plugins"
        className="self-start rounded-md px-2 py-1 -ml-2 text-muted-foreground transition-colors duration-100 hover:bg-secondary-hover hover:text-foreground"
      >
        ← Plugins
      </Link>

      {error && <p className="text-destructive-foreground">Couldn't load this plugin: {error}</p>}
      {!plugin && !error && <p className="text-muted-foreground">Loading…</p>}

      {plugin && (
        <>
          <header className="flex items-start gap-4">
            <PluginIcon plugin={plugin} size={56} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold">{plugin.displayName}</h2>
                <PluginStatus status={plugin.status} />
              </div>
              <p className="text-base text-muted-foreground">{plugin.description}</p>
              {plugin.version && <p className="text-sm text-muted-foreground">Version {plugin.version}</p>}
            </div>
          </header>

          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">Accounts</h3>
            {plugin.status === 'not_connected' && (
              <p className="text-muted-foreground">
                {plugin.servers.length ? `No ${plugin.displayName} account is connected yet.` : `${plugin.displayName} needs no account: it brings skills only.`}
              </p>
            )}
          </div>

          {plugin.servers.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">{plugin.servers.length > 1 ? 'Servers' : 'Server'}</h3>
              <ul className="flex flex-col gap-1">
                {plugin.servers.map((server) => (
                  <li key={server.name} className="truncate font-mono text-sm text-muted-foreground">
                    {server.url}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plugin.skills.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Skills</h3>
              <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
                {plugin.skills.map((skill) => (
                  <li key={skill.name} className="flex flex-col px-4 py-3">
                    <span className="font-medium">{skill.name}</span>
                    <span className="text-sm text-muted-foreground">{skill.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
