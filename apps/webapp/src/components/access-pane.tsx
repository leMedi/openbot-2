import type { BotInfo, PluginAccountInfo, PluginInfo } from '@openbot/api-contract'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { GrantSwitch, PluginIcon, PluginStatus } from './plugins.tsx'

/**
 * The bot's Access pane (design §5.5): every plugin of the catalog with an account to sign in to, and for each of its
 * connected accounts whether the bot may use it, which the owner grants and revokes here. A plugin not connected
 * yet links to its page in Settings → Plugins.
 */
export function AccessPane({ bot }: { bot: BotInfo }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let current = true
    api()
      .plugins.list()
      .then((loaded) => {
        if (!current) return
        setPlugins(loaded)
        setError(undefined)
      })
      .catch((caught) => current && setError(errorMessage(caught)))
    return () => {
      current = false
    }
  }, [])

  function changed(plugin: PluginInfo, account: PluginAccountInfo) {
    setPlugins((current) =>
      current?.map((entry) =>
        entry.name === plugin.name ? { ...entry, accounts: entry.accounts.map((other) => (other.slug === account.slug ? account : other)) } : entry,
      ),
    )
  }

  const hosted = plugins?.filter((plugin) => plugin.servers.length > 0)
  return (
    <aside aria-label={`${bot.name}'s access`} className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Access</h2>
        <p className="text-sm text-muted-foreground">The plugin accounts {bot.name} may use. A revoke takes effect from its next call.</p>
      </header>
      {error && <p className="text-sm text-destructive-foreground">Couldn't load the plugins: {error}</p>}
      {hosted && !hosted.length && <p className="text-sm text-muted-foreground">No plugin has an account to grant.</p>}
      <ul className="flex flex-col gap-3">
        {hosted?.map((plugin) => (
          <li key={plugin.name} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <PluginIcon plugin={plugin} size={24} />
              <Link to="/settings/plugins/$name" params={{ name: plugin.name }} className="min-w-0 flex-1 truncate font-medium hover:underline">
                {plugin.displayName}
              </Link>
              {!plugin.accounts.length && <PluginStatus status={plugin.status} />}
            </div>
            {plugin.accounts.map((account) => (
              <GrantSwitch
                key={account.slug}
                plugin={plugin}
                account={account}
                bot={bot}
                label={account.displayName}
                onChanged={(saved) => changed(plugin, saved)}
              />
            ))}
          </li>
        ))}
      </ul>
    </aside>
  )
}
