import type { PluginReconnectCardInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useState } from 'react'
import { ReconnectWizard } from './plugins.tsx'

/**
 * A plugin account the bot is granted needs reconnecting (design §5.5): its sign-in expired and couldn't be refreshed.
 * **Reconnect** signs in to it again, keeping its slug and grants; once it is reconnected, from here or Settings →
 * Plugins, or disconnected instead, the card says so.
 */
export function PluginReconnectCard({ card, botName }: { card: PluginReconnectCardInfo; botName: string }) {
  const [reconnecting, setReconnecting] = useState(false)
  const waiting = !card.outcome
  const label = `${card.displayName} (${card.account.displayName})`
  return (
    <section
      aria-label={`${label} needs reconnecting`}
      className={cn('flex w-full flex-col gap-3 rounded-2xl bg-bubble-agent p-3 text-base/5', waiting && 'border border-border')}
    >
      <header className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={cn('size-1.5 rounded-full', waiting ? 'bg-amber motion-safe:animate-pulse' : card.outcome === 'reconnected' ? 'bg-green' : 'bg-muted-foreground')}
          />
          {waiting ? 'Needs reconnect' : card.outcome === 'reconnected' ? 'Reconnected' : 'Disconnected'}
        </span>
      </header>
      <p className={cn('text-sm [overflow-wrap:anywhere]', !waiting && 'text-muted-foreground')}>
        The sign-in to {label} expired and couldn't be renewed, so {botName} can't use its tools until you reconnect it.
      </p>
      {waiting && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setReconnecting(true)}
            className="pressable rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Reconnect
          </button>
        </div>
      )}
      {reconnecting && (
        <ReconnectWizard
          plugin={{ name: card.plugin, displayName: card.displayName }}
          account={card.account}
          // The card itself changes with the server's message.updated.
          onClose={() => setReconnecting(false)}
        />
      )}
    </section>
  )
}
