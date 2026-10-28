import type { MessageInfo, PluginInfo, PluginRequestCardInfo, PluginRequestChoice } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { PluginIcon } from './plugins.tsx'
import { SignInWizard } from './sign-in-wizard.tsx'

/** The picker's choice that connects a new account instead of granting a connected one. */
const another = 'another'

/**
 * A bot asks for a plugin (design §5.5): the plugin and the bot's reason, then, while it waits, **Connect** when the
 * plugin has no account (signing in grants the new account), an account picker with "Connect another account" and
 * **Allow** when it has, or **Allow** alone for a plugin of skills only; **Deny** in every case. Once decided it shows
 * the account granted, or that it was denied.
 */
export function PluginRequestCard({
  message,
  card,
  botName,
  onDecided,
}: {
  message: MessageInfo
  card: PluginRequestCardInfo
  botName: string
  onDecided: (message: MessageInfo) => void
}) {
  const waiting = !card.decision
  const [plugin, setPlugin] = useState<PluginInfo>()
  const [picked, setPicked] = useState<string>()
  const [connecting, setConnecting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()

  const load = () => api().plugins.get({ name: card.plugin }).then(setPlugin, (caught) => setError(errorMessage(caught)))
  useEffect(() => {
    void load()
  }, [card.plugin])

  const accounts = plugin?.accounts ?? []
  // An account picked, then disconnected, falls back to the first.
  const choice = (picked === another || accounts.some((account) => account.slug === picked) ? picked : undefined) ?? accounts[0]?.slug ?? another

  async function decide(decision: PluginRequestChoice) {
    if (sending || !waiting) return
    setSending(true)
    setError(undefined)
    try {
      onDecided(await api().chats.decidePluginRequest({ messageId: message.id, decision }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSending(false)
    }
  }

  function allow() {
    if (card.skillsOnly) return void decide({ outcome: 'granted', account: null })
    if (choice === another) return setConnecting(true)
    void decide({ outcome: 'granted', account: choice })
  }

  const status = !card.decision
    ? { label: 'Action needed', dot: 'bg-amber' }
    : card.decision.outcome === 'granted'
      ? { label: card.decision.account ? `Granted · ${card.decision.account.displayName}` : 'Granted', dot: 'bg-green' }
      : { label: 'Denied', dot: 'bg-muted-foreground' }
  const primary = 'pressable rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60'
  return (
    <section
      aria-label={`${botName} asks for ${card.displayName}`}
      className={cn('flex w-full flex-col gap-3 rounded-2xl bg-bubble-agent p-3 text-base/5', waiting && 'border border-border')}
    >
      <header className="flex items-center gap-2">
        {plugin && <PluginIcon plugin={plugin} size={20} />}
        <span className="min-w-0 truncate text-sm font-medium">{card.displayName}</span>
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn('size-1.5 rounded-full', status.dot, waiting && 'motion-safe:animate-pulse')} />
          {status.label}
        </span>
      </header>
      <p className={cn('text-sm [overflow-wrap:anywhere]', !waiting && 'text-muted-foreground')}>
        {botName} wants to use {card.displayName}: {card.reason}
      </p>
      {waiting && plugin && !card.skillsOnly && accounts.length > 0 && (
        <fieldset className="flex flex-col gap-1 text-sm" disabled={sending}>
          <legend className="sr-only">Account to grant</legend>
          {[...accounts.map((account) => ({ value: account.slug, label: account.displayName })), { value: another, label: 'Connect another account' }].map(
            (option) => (
              <label key={option.value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`plugin-request-${message.id}`}
                  value={option.value}
                  checked={choice === option.value}
                  onChange={() => setPicked(option.value)}
                  className="size-4 accent-primary"
                />
                <span className="min-w-0 truncate">{option.label}</span>
              </label>
            ),
          )}
        </fieldset>
      )}
      {waiting && (
        <div className="flex flex-wrap items-center gap-2">
          {card.skillsOnly || accounts.length > 0 ? (
            <button type="button" disabled={sending || !plugin} onClick={allow} className={primary}>
              {choice === another && !card.skillsOnly ? 'Connect' : 'Allow'}
            </button>
          ) : (
            <button type="button" disabled={sending || !plugin} onClick={() => setConnecting(true)} className={primary}>
              Connect
            </button>
          )}
          <button
            type="button"
            disabled={sending}
            onClick={() => void decide({ outcome: 'denied' })}
            className="pressable rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-secondary-hover hover:text-foreground disabled:opacity-60"
          >
            Deny
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {connecting && (
        <SignInWizard
          title={`Connect ${card.displayName}`}
          subtitle={`For ${botName}${accounts.length ? ', another account' : ''}`}
          start={(signal) => api().plugins.connect({ name: card.plugin, origin: window.location.origin, requestId: message.id }, { signal })}
          answer={(signInId, promptId, value) => api().plugins.answer({ signInId, promptId, value })}
          onClose={(connected) => {
            setConnecting(false)
            // The card itself changes with the server's message.updated.
            if (connected) void load()
          }}
        />
      )}
    </section>
  )
}
