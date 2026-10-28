import { type PluginAccountInfo, type PluginInfo, pluginAccountNameMax } from '@openbot/api-contract'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Dialog } from '../../components/dialog.tsx'
import { GrantSwitch, PluginIcon, PluginStatus } from '../../components/plugins.tsx'
import { SignInWizard } from '../../components/sign-in-wizard.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/settings/plugins/$name')({
  component: PluginDetail,
})

/**
 * A plugin's detail view in Settings → Plugins: what it is, its status, its accounts (connect, rename, disconnect, and
 * the bots granted each), and the servers and skills it brings.
 */
function PluginDetail() {
  const { name } = Route.useParams()
  const [plugin, setPlugin] = useState<PluginInfo>()
  const [error, setError] = useState<string>()
  const [connecting, setConnecting] = useState(false)

  const load = useCallback(() => {
    api().plugins.get({ name }).then(setPlugin, (caught) => setError(errorMessage(caught)))
  }, [name])

  useEffect(() => {
    setPlugin(undefined)
    setError(undefined)
    load()
  }, [load])

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
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">Accounts</h3>
              {plugin.servers.length > 0 && (
                <button
                  type="button"
                  className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover"
                  onClick={() => setConnecting(true)}
                >
                  {plugin.accounts.length ? 'Connect another account' : 'Connect'}
                </button>
              )}
            </div>
            {plugin.accounts.length === 0 && (
              <p className="text-muted-foreground">
                {plugin.servers.length ? `No ${plugin.displayName} account is connected yet.` : `${plugin.displayName} needs no account: it brings skills only.`}
              </p>
            )}
            {plugin.accounts.length > 0 && (
              <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
                {plugin.accounts.map((account) => (
                  <AccountRow key={account.slug} plugin={plugin} account={account} onChanged={load} />
                ))}
              </ul>
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

      {plugin && connecting && (
        <SignInWizard
          title={`Connect ${plugin.displayName}`}
          subtitle={plugin.accounts.length ? 'Another account' : undefined}
          start={(signal) => api().plugins.connect({ name: plugin.name, origin: window.location.origin }, { signal })}
          answer={(signInId, promptId, value) => api().plugins.answer({ signInId, promptId, value })}
          onClose={(connected) => {
            setConnecting(false)
            if (connected) load()
          }}
        />
      )}
    </section>
  )
}

/** One connected account: its name, which the owner can change, its slug, Disconnect, and the bots granted it. */
function AccountRow({ plugin, account, onChanged }: { plugin: PluginInfo; account: PluginAccountInfo; onChanged: () => void }) {
  const { bots } = useLive()
  const [renaming, setRenaming] = useState(false)
  const [displayName, setDisplayName] = useState(account.displayName)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string>()

  async function rename(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    try {
      await api().plugins.renameAccount({ name: plugin.name, account: account.slug, displayName })
      setRenaming(false)
      onChanged()
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function disconnect() {
    try {
      await api().plugins.disconnectAccount({ name: plugin.name, account: account.slug })
      onChanged()
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      {renaming ? (
        <form onSubmit={rename} className="flex items-center gap-2">
          <input
            aria-label="Account name"
            autoFocus
            maxLength={pluginAccountNameMax}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              setDisplayName(account.displayName)
              setRenaming(false)
            }}
            className="min-w-0 flex-1 rounded-md border border-input bg-input-fill px-2.5 py-1.5 text-base outline-offset-0"
          />
          <button
            type="submit"
            disabled={!displayName.trim()}
            className="pressable rounded-md bg-primary px-3 py-1.5 text-base text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            Save
          </button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{account.displayName}</span>
            <span className="text-sm text-muted-foreground">
              <span className="font-mono">{account.slug}</span> · connected {new Date(account.connectedAt).toLocaleDateString()}
            </span>
          </span>
          <button type="button" className="pressable rounded-md px-3 py-1.5 text-base hover:bg-secondary-hover" onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button
            type="button"
            className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover"
            onClick={() => setDisconnecting(true)}
          >
            Disconnect
          </button>
        </div>
      )}
      {error && <p className="text-sm text-destructive-foreground">{error}</p>}
      {bots && bots.length > 0 && (
        <fieldset className="mt-1 flex flex-col gap-1">
          <legend className="mb-1 text-sm text-muted-foreground">Bots that may use it</legend>
          {bots.map((bot) => (
            <GrantSwitch key={bot.id} plugin={plugin} account={account} bot={bot} label={bot.name} onChanged={onChanged} />
          ))}
        </fieldset>
      )}

      {disconnecting && (
        <Dialog label={`Disconnect ${account.displayName}`} onClose={() => setDisconnecting(false)}>
          {(close) => (
            <>
              <header className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold">
                  Disconnect {plugin.displayName} ({account.displayName})?
                </h2>
                <p className="text-muted-foreground">
                  OpenBot forgets this account's sign-in, and the bots granted it lose its tools. Connecting it again gives it a new slug, so bots see it as a new account.
                </p>
              </header>
              <footer className="flex justify-end gap-2">
                <button type="button" data-autofocus onClick={close} className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    close()
                    void disconnect()
                  }}
                  className="pressable rounded-md bg-destructive px-3 py-1.5 text-base text-on-color hover:bg-destructive/90"
                >
                  Disconnect
                </button>
              </footer>
            </>
          )}
        </Dialog>
      )}
    </li>
  )
}
