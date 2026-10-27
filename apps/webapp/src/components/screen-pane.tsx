import type { BotInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'

// Every screen is 1280×800 (`screenSize` on the server).
const aspect = '1280 / 800'
/** Failed connections in a row before the owner is told the screen can't be reached. */
const attemptsBeforeUnreachable = 3
/** How often a take-over renews the server's hold, well within its 60 s. */
const holdRenewMs = 20_000

type ViewState = 'connecting' | 'starting' | 'connected' | 'unreachable'

/**
 * Keeps the server's hold on the bot's screen while `control` is on, renewing it, and hands the screen back when it goes
 * off: the bot's computer-use sessions pause meanwhile, so their input never fights the owner's.
 */
function useScreenHold(botId: string, control: boolean) {
  useEffect(() => {
    if (!control) return
    // A failed hold only means sessions aren't paused; the owner still has the screen.
    const hold = () => api().screens.hold({ botId }).catch(() => {})
    void hold()
    const timer = setInterval(hold, holdRenewMs)
    return () => {
      clearInterval(timer)
      api().screens.release({ botId }).catch(() => {})
    }
  }, [botId, control])
}

/**
 * A bot's screen beside its DM, like Grok's computer pane: live and view-only, opening fullscreen; **Take over** gives
 * the owner its mouse and keyboard until **Hand back**. `control` is the DM's, so a take-over card can turn it on.
 */
export function ScreenPane({ bot, control, onControl }: { bot: BotInfo; control: boolean; onControl: (control: boolean) => void }) {
  const [fullscreen, setFullscreen] = useState(false)
  useScreenHold(bot.id, control)

  // Another bot's screen starts in the pane.
  useEffect(() => setFullscreen(false), [bot.id])

  const takeOver = (
    <button
      type="button"
      aria-pressed={control}
      onClick={() => onControl(!control)}
      className={cn(
        'pressable rounded-md px-2.5 py-1 text-sm font-medium',
        control ? 'bg-primary text-primary-foreground hover:bg-primary-hover' : 'bg-secondary hover:bg-secondary-hover',
      )}
    >
      {control ? 'Hand back' : '✋ Take over'}
    </button>
  )

  return (
    <aside aria-label={`${bot.name}'s screen`} className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border-subtle p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Screen</h2>
        {takeOver}
      </header>
      {fullscreen ? (
        <div style={{ aspectRatio: aspect }} className="grid place-items-center rounded-md bg-secondary text-sm text-muted-foreground">
          Open in fullscreen
        </div>
      ) : (
        <div className="group relative">
          <ScreenView key={bot.id} bot={bot} control={control} className="rounded-md" />
          {!control && (
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              className="absolute inset-0 grid place-items-center rounded-md bg-black/45 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <span className="rounded-full bg-white px-3 py-1 text-sm font-medium text-black">⤢ Open</span>
            </button>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {control ? `You're controlling ${bot.name}'s screen` : `${bot.name}'s screen`}
      </p>
      {fullscreen && <FullscreenScreen bot={bot} control={control} takeOver={takeOver} onClose={() => setFullscreen(false)} />}
    </aside>
  )
}

/** The screen over the whole window, dark in both themes, like Grok's take-control view. */
function FullscreenScreen({ bot, control, takeOver, onClose }: { bot: BotInfo; control: boolean; takeOver: React.ReactNode; onClose: () => void }) {
  // Escape leaves while watching; while in control, keys go to the screen.
  useEffect(() => {
    if (control) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [control, onClose])

  return (
    <div role="dialog" aria-label={`${bot.name}'s screen`} className="fixed inset-0 z-40 flex flex-col bg-[#141414f2] text-white">
      <div className="flex h-11 shrink-0 items-center gap-3 bg-black/55 px-4">
        <span className="text-sm font-semibold">{bot.name}'s screen</span>
        <span className="ml-auto">{takeOver}</span>
        <button type="button" onClick={onClose} aria-label="Exit fullscreen" className="rounded-md px-2 py-1 text-lg hover:bg-white/10">
          ✕
        </button>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center p-2 [container-type:size]">
        <div style={{ width: 'min(100cqw, 100cqh * 1280 / 800)' }}>
          <ScreenView bot={bot} control={control} className="rounded-md" dark />
        </div>
      </div>
    </div>
  )
}

/** The live screen: a ticket, then the stream over a WebSocket, reconnecting when it drops. */
function ScreenView({ bot, control, className, dark }: { bot: BotInfo; control: boolean; className?: string; dark?: boolean }) {
  const target = useRef<HTMLDivElement>(null)
  const rfb = useRef<import('@novnc/novnc').default>(undefined)
  const [state, setState] = useState<ViewState>('connecting')
  const [retry, setRetry] = useState(0)
  const controlRef = useRef(control)
  controlRef.current = control

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
      client.viewOnly = !controlRef.current
      client.addEventListener('connect', () => {
        failures = 0
        setState('connected')
        if (controlRef.current) client.focus()
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
  }, [bot.id, retry])

  useEffect(() => {
    const client = rfb.current
    if (!client) return
    client.viewOnly = !control
    if (control) client.focus()
    else client.blur()
  }, [control])

  return (
    <div
      style={{ aspectRatio: aspect }}
      className={cn('relative overflow-hidden', dark ? 'bg-white/5' : 'bg-secondary', control && 'ring-2 ring-link', className)}
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
