import type { HandBackOutcome, MessageInfo, TakeOverCardInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'

const status = {
  waiting: { label: 'Action needed', dot: 'bg-amber' },
  done: { label: 'Done', dot: 'bg-green' },
  skipped: { label: 'Skipped', dot: 'bg-muted-foreground' },
} as const

/** Hands a bot's screen back from its take-over card, once at a time, keeping the error to show. */
export function useHandBack(messageId: string, onHandedBack: (message: MessageInfo) => void) {
  const [sending, setSending] = useState<HandBackOutcome>()
  const [error, setError] = useState<string>()

  async function handBack(outcome: HandBackOutcome) {
    if (sending) return
    setSending(outcome)
    setError(undefined)
    try {
      onHandedBack(await api().chats.handBack({ messageId, outcome }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSending(undefined)
    }
  }

  return { sending, error, handBack }
}

/**
 * A bot stuck on its screen asks the owner to take over (as Grok's card for handing over its computer): the instruction, then **Take over**,
 * which opens the screen fullscreen, where the owner controls it, **I'm done**, which hands it back and wakes the bot, and
 * **Skip**, which hands it back without doing the step. Once handed back it shows how, and opens the screen.
 */
export function TakeOverCard({
  message,
  card,
  botName,
  onTakeOver,
  onOpenScreen,
  onHandedBack,
}: {
  message: MessageInfo
  card: TakeOverCardInfo
  botName: string
  onTakeOver: () => void
  onOpenScreen: () => void
  onHandedBack: (message: MessageInfo) => void
}) {
  const { sending, error, handBack } = useHandBack(message.id, onHandedBack)

  const { label, dot } = status[card.outcome ?? 'waiting']
  return (
    <section
      aria-label={`${botName} needs you on its screen`}
      className={cn('flex w-full flex-col gap-3 rounded-2xl bg-bubble-agent p-3 text-base/5', !card.outcome && 'border border-border')}
    >
      <header className="flex items-center gap-2">
        <span className="text-sm font-medium">Screen</span>
        <span className="flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn('size-1.5 rounded-full', dot, !card.outcome && 'motion-safe:animate-pulse')} />
          {label}
        </span>
      </header>
      <p className={cn('text-sm [overflow-wrap:anywhere]', card.outcome && 'text-muted-foreground')}>{card.instruction}</p>
      {card.outcome ? (
        <div>
          <button type="button" onClick={onOpenScreen} className="pressable rounded-md bg-secondary px-2.5 py-1 text-sm font-medium hover:bg-secondary-hover">
            Open screen
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onTakeOver}
            className="pressable rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            ✋ Take over
          </button>
          <button
            type="button"
            disabled={!!sending}
            onClick={() => !card.outcome && void handBack('done')}
            className="pressable rounded-md border border-border px-2.5 py-1 text-sm font-medium hover:bg-secondary-hover disabled:opacity-60"
          >
            I'm done
          </button>
          <button
            type="button"
            disabled={!!sending}
            onClick={() => !card.outcome && void handBack('skipped')}
            title={`Cancel this request without doing the step; ${botName} continues without it`}
            className="pressable rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-secondary-hover hover:text-foreground disabled:opacity-60"
          >
            Skip
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
    </section>
  )
}
