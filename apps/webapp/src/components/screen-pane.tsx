import type { BotInfo, MessageInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { useHandBack } from './take-over-card.tsx'

// Every screen is 1280×800 (`screenSize` on the server).
const aspect = '1280 / 800'
/** Failed connections in a row before the owner is told the screen can't be reached. */
const attemptsBeforeUnreachable = 3

type ViewState = 'connecting' | 'starting' | 'connected' | 'unreachable'

/**
 * A bot's screen beside its DM, like Grok's computer preview: live and view-only, with **⤢ Open** to take it fullscreen,
 * where the owner controls it. While a take-over card waits, its instruction sits above the screen with **Skip this
 * step** and **I'm done, continue**. `takeOver` is that card's message.
 */
export function ScreenPane({ bot, takeOver, onOpen }: { bot: BotInfo; takeOver?: MessageInfo; onOpen: () => void }) {
  return (
    <aside aria-label={`${bot.name}'s screen`} className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border-subtle p-5">
      <h2 className="text-lg font-semibold">Screen</h2>
      {takeOver?.card?.type === 'take_over' && <AttentionCard key={takeOver.id} message={takeOver} instruction={takeOver.card.instruction} botName={bot.name} />}
      <div className="group relative">
        <ScreenView key={bot.id} bot={bot} className="rounded-md" />
        <button
          type="button"
          onClick={onOpen}
          className="absolute inset-0 grid place-items-center rounded-md bg-black/45 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <span className="rounded-full bg-white px-3 py-1 text-sm font-medium text-black">⤢ Open</span>
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{bot.name}'s screen</p>
    </aside>
  )
}

/** A waiting take-over card at the top of the pane, as Grok's attention card. */
function AttentionCard({ message, instruction, botName }: { message: MessageInfo; instruction: string; botName: string }) {
  // The card's message updates live once handed back, which takes this away.
  const { sending, error, handBack } = useHandBack(message.id, () => {})
  return (
    <section aria-label="Needs your attention" className="flex flex-col gap-2 rounded-[14px] bg-amber/10 p-2.5 ring-1 ring-amber/20 ring-inset">
      <p className="text-sm font-medium text-amber-foreground">Needs your attention</p>
      <p className="text-sm [overflow-wrap:anywhere]">{instruction.trim() || `${botName} needs you`}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!!sending}
          onClick={() => void handBack('skipped')}
          className="pressable rounded-md bg-secondary px-2.5 py-1 text-sm font-medium hover:bg-secondary-hover disabled:opacity-60"
        >
          Skip this step
        </button>
        <button
          type="button"
          disabled={!!sending}
          onClick={() => void handBack('done')}
          className="pressable rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
        >
          I'm done, continue
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * The screen over the whole window, dark in both themes, like Grok's take-control view: the owner controls it at once.
 * While a take-over card waits, a banner above the screen offers **Skip this step** and **I'm done, continue**; either
 * hands the screen back and leaves fullscreen. Leaving hands nothing back.
 */
export function FullscreenScreen({ bot, takeOver, onClose }: { bot: BotInfo; takeOver?: MessageInfo; onClose: () => void }) {
  function handBack(outcome: 'done' | 'skipped') {
    // As in Grok: sent, and fullscreen closes without waiting; the card shows how it went.
    if (takeOver) api().chats.handBack({ messageId: takeOver.id, outcome }).catch((error) => console.error("[screen] Couldn't hand back:", error))
    onClose()
  }

  return (
    <div role="dialog" aria-label={`${bot.name}'s screen`} className="fixed inset-0 z-40 flex flex-col bg-[#141414f2] text-white">
      <div className="flex h-11 shrink-0 items-center gap-3 bg-black/55 px-4">
        <span className="text-sm font-semibold">{bot.name}'s screen</span>
        <button type="button" onClick={onClose} aria-label="Exit fullscreen" className="ml-auto rounded-md px-2 py-1 text-lg hover:bg-white/10">
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {takeOver?.card?.type === 'take_over' && (
          <div role="status" className="flex shrink-0 items-center gap-3 rounded-[10px] bg-[#f9850021] py-2.5 pr-2.5 pl-3 text-sm text-[#ffbd3b]">
            <p className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">{takeOver.card.instruction}</p>
            <button
              type="button"
              onClick={() => handBack('skipped')}
              className="pressable shrink-0 rounded-md bg-white/10 px-2.5 py-1 font-medium text-white hover:bg-white/15"
            >
              Skip this step
            </button>
            <button
              type="button"
              onClick={() => handBack('done')}
              className="pressable shrink-0 rounded-md bg-[#fdfdfd] px-2.5 py-1 font-medium text-black hover:bg-white"
            >
              I'm done, continue
            </button>
          </div>
        )}
        <div className="grid min-h-0 flex-1 place-items-center [container-type:size]">
          <div style={{ width: 'min(100cqw, 100cqh * 1280 / 800)' }}>
            <ScreenView bot={bot} interactive className="rounded-md" dark />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The live screen: a ticket, then the stream over a WebSocket, reconnecting when it drops. */
function ScreenView({ bot, interactive = false, className, dark }: { bot: BotInfo; interactive?: boolean; className?: string; dark?: boolean }) {
  const target = useRef<HTMLDivElement>(null)
  const rfb = useRef<import('@novnc/novnc').default>(undefined)
  const [state, setState] = useState<ViewState>('connecting')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setState('connecting')

    const again = (delayMs: number) => {
      if (!cancelled) timer = setTimeout(connect, delayMs)
    }

    async function connect() {
      let url: string
      try {
        url = (await api().screens.ticket({ botId: bot.id })).url
      } catch (error) {
        if (cancelled) return
        if ((error as { code?: string }).code === 'PRECONDITION_FAILED') {
          setState('starting')
          return again(1_500)
        }
        return fail()
      }
      const { default: RFB } = await import('@novnc/novnc')
      if (cancelled || !target.current) return
      const origin = new URL(window.location.href)
      origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
      const client = new RFB(target.current, new URL(url, origin).href, { shared: true })
      client.scaleViewport = true
      client.background = 'transparent'
      client.viewOnly = !interactive
      client.addEventListener('connect', () => {
        failures = 0
        setState('connected')
        // Fullscreen takes the keyboard at once.
        if (interactive) client.focus()
      })
      client.addEventListener('disconnect', () => {
        if (rfb.current === client) rfb.current = undefined
        fail()
      })
      rfb.current = client
    }

    function fail() {
      if (cancelled) return
      if (++failures >= attemptsBeforeUnreachable) return setState('unreachable')
      setState('connecting')
      again(1_000 * failures)
    }

    void connect()
    return () => {
      cancelled = true
      clearTimeout(timer)
      rfb.current?.disconnect()
      rfb.current = undefined
    }
  }, [bot.id, interactive, retry])

  return (
    <div
      style={{ aspectRatio: aspect }}
      className={cn('relative overflow-hidden', dark ? 'bg-white/5' : 'bg-secondary', className)}
    >
      <div ref={target} data-testid="screen" className={cn('absolute inset-0', state !== 'connected' && 'invisible')} />
      {state !== 'connected' && (
        <div className={cn('absolute inset-0 grid place-items-center p-4 text-center text-sm', dark ? 'text-white/70' : 'text-muted-foreground')}>
          {state === 'unreachable' ? (
            <div className="flex flex-col items-center gap-2">
              <span>Can't reach {bot.name}'s screen</span>
              <button
                type="button"
                onClick={() => setRetry((count) => count + 1)}
                className="rounded-full bg-secondary px-3 py-1 text-sm text-foreground hover:bg-secondary-hover"
              >
                Retry
              </button>
            </div>
          ) : (
            <span className="flex items-center gap-2">
              <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {state === 'starting' ? 'Booting up the computer' : `Connecting to ${bot.name}'s screen…`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
