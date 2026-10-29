import type { BotInfo, PluginAccountInfo, PluginInfo } from '@openbot/api-contract'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { GrantSwitch, PluginIcon, PluginStatus, SkillsGrantSwitch } from './plugins.tsx'

/**
 * The bot's Access pane (design §5.5): the connected plugins and those of skills only, and whether the bot may use each
 * connected account of a plugin, or the skills of a plugin of skills only, which the owner grants and revokes here. The
 * plugins not connected yet are counted, with a link to Settings → Plugins to connect them.
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

  const grantable = plugins?.filter((plugin) => plugin.accounts.length > 0 || (!plugin.servers.length && plugin.skills.length > 0))
  const unconnected = plugins?.filter((plugin) => plugin.servers.length > 0 && !plugin.accounts.length).length ?? 0
  return (
    <aside aria-label={`${bot.name}'s access`} className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Access</h2>
        <p className="text-sm text-muted-foreground">
          The plugin accounts and skills {bot.name} may use. An account's revoke takes effect from its next call; skills change when its history is next compacted.
        </p>
      </header>
      {error && <p className="text-sm text-destructive-foreground">Couldn't load the plugins: {error}</p>}
      {grantable && !grantable.length && <p className="text-sm text-muted-foreground">No plugin has an account or skills to grant yet.</p>}
      <ul className="flex flex-col gap-3">
        {grantable?.map((plugin) => (
          <li key={plugin.name} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <PluginIcon plugin={plugin} size={24} />
              <Link to="/settings/plugins/$name" params={{ name: plugin.name }} className="min-w-0 flex-1 truncate font-medium hover:underline">
                {plugin.displayName}
              </Link>
              {plugin.status === 'needs_reconnect' && <PluginStatus status={plugin.status} />}
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
            {!plugin.servers.length && (
              <SkillsGrantSwitch
                plugin={plugin}
                bot={bot}
                label="Its skills"
                onChanged={(saved) => setPlugins((current) => current?.map((entry) => (entry.name === saved.name ? saved : entry)))}
              />
            )}
          </li>
        ))}
      </ul>
      {unconnected > 0 && (
        <p className="text-sm text-muted-foreground">
          {unconnected} more {unconnected === 1 ? 'plugin is' : 'plugins are'} not connected yet:{' '}
          <Link to="/settings/plugins" className="text-foreground hover:underline">
            connect them in Settings → Plugins
          </Link>
          .
        </p>
      )}
    </aside>
  )
}
