import type { BotInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AccessPane } from '../../components/access-pane.tsx'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { ChatView } from '../../components/chat-view.tsx'
import { MemoryPane } from '../../components/memory-pane.tsx'
import { ProfilePane } from '../../components/profile-pane.tsx'
import { RoutinesPane, type RoutineToOpen } from '../../components/routines-pane.tsx'
import { FullscreenScreen, ScreenPane } from '../../components/screen-pane.tsx'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/bots/$botId')({
  component: Dm,
})

/** The right-hand pane beside a DM: one at a time, the bot's screen by default. */
type Pane = 'screen' | 'profile' | 'routines' | 'memory' | 'access'

/** The DM between the owner and one bot, in Grok Bot's layout, with its Screen, Profile, Routines, Memory or Access pane beside it. */
function Dm() {
  const { botId } = Route.useParams()
  const live = useLive()
  const navigate = useNavigate()
  const [pane, setPane] = useState<Pane | null>('screen')
  /** The routine a timeline chip asked the Routines pane to open. */
  const [routineToOpen, setRoutineToOpen] = useState<RoutineToOpen>()
  /** Whether the bot's screen is fullscreen, where the owner controls it; another bot's starts closed. */
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    setFullscreen(false)
    setRoutineToOpen(undefined)
  }, [botId])
  const bot = live.bots?.find((entry) => entry.id === botId)
  const waitingTakeOver = bot && [...(live.messages.get(bot.chatId) ?? [])].reverse().find((message) => message.card?.type === 'take_over' && !message.card.outcome)
  function closeFullscreen() {
    setFullscreen(false)
    // As in Grok, the owner goes back to the composer.
    document.querySelector<HTMLElement>('[data-composer]')?.focus()
  }
  if (!bot) return live.bots ? <p className="m-auto text-muted-foreground">This bot doesn't exist.</p> : null
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Keyed, so loading state, scroll position and sends in flight belong to one chat. */}
        <ChatView
          key={bot.chatId}
          chatId={bot.chatId}
          header={
            <DmHeader
              bot={bot}
              pane={pane}
              onTogglePane={(next) => {
                setRoutineToOpen(undefined)
                setPane((open) => (open === next ? null : next))
              }}
            />
          }
          notice={bot.error && !bot.working && <ModelError bot={bot} />}
          composerLabel={`Message ${bot.name}`}
          emptyText={`Say hi to ${bot.name}.`}
          typing={bot.working ? bot : undefined}
          allowFiles
          showAuthors={false}
          onScreen={() => setFullscreen(true)}
          onOpenRoutine={(routineId) => {
            setRoutineToOpen({ routineId, requestedAt: Date.now() })
            setPane('routines')
          }}
        />
      </div>
      {pane === 'screen' && <ScreenPane bot={bot} takeOver={waitingTakeOver} onOpen={() => setFullscreen(true)} />}
      {fullscreen && <FullscreenScreen bot={bot} takeOver={waitingTakeOver} onClose={closeFullscreen} />}
      {pane === 'memory' && <MemoryPane bot={bot} />}
      {pane === 'access' && <AccessPane key={bot.id} bot={bot} />}
      {pane === 'routines' && <RoutinesPane key={bot.id} bot={bot} open={routineToOpen} onClose={() => setPane(null)} />}
      {pane === 'profile' && (
        <ProfilePane
          bot={bot}
          onSaved={(saved) => live.updateBot(saved)}
          onDeleted={() => {
            live.removeBot(bot.id, bot.chatId)
            navigate({ to: '/', replace: true })
          }}
        />
      )}
    </div>
  )
}

const paneLabels = { screen: 'Screen', profile: 'Profile', routines: 'Routines' } as const

/** The DM's bar: the bot, whether it works, and the pane toggles. */
function DmHeader({ bot, pane, onTogglePane }: { bot: BotInfo; pane: Pane | null; onTogglePane: (pane: Pane) => void }) {
  return (
    <header className="chat-material sticky top-0 z-10 flex min-h-[51px] items-center gap-2 px-4">
      <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} />
      <span className="font-semibold">{bot.name}</span>
      {bot.working && <span className="animate-fade-in text-sm text-muted-foreground">Working</span>}
      <span className="ml-auto flex gap-1">
        {(['screen', 'profile', 'routines'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={pane === choice}
            onClick={() => onTogglePane(choice)}
            className={cn('pressable rounded-md px-2 py-1 text-base hover:bg-secondary-hover', pane === choice && 'bg-selected')}
          >
            {paneLabels[choice]}
          </button>
        ))}
        <MoreMenu pane={pane} onToggle={onTogglePane} />
      </span>
    </header>
  )
}

/** "⋯": the bot's other panes: its Memory and Access. */
function MoreMenu({ pane, onToggle }: { pane: Pane | null; onToggle: (pane: Pane) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    addEventListener('pointerdown', close, true)
    return () => removeEventListener('pointerdown', close, true)
  }, [open])
  const items: { pane: Pane; label: string }[] = [
    { pane: 'memory', label: 'Memory' },
    { pane: 'access', label: 'Access' },
  ]
  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
        className={cn('pressable rounded-md px-2 py-1 text-base hover:bg-secondary-hover', items.some((item) => item.pane === pane) && 'bg-selected')}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          aria-label="More"
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') {
              event.preventDefault()
              setOpen(false)
            }
          }}
          className="absolute top-full right-0 z-40 mt-1 flex min-w-[150px] flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg motion-safe:animate-pop-in motion-reduce:animate-fade-in"
        >
          {items.map((item) => (
            <button
              key={item.pane}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false)
                onToggle(item.pane)
              }}
              className="rounded-md px-2.5 py-1.5 text-left text-base outline-none hover:bg-secondary focus-visible:bg-secondary"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/** Why the bot's latest run failed, and where to fix it. */
function ModelError({ bot }: { bot: BotInfo }) {
  return (
    <p
      role="alert"
      className="mx-[max(24px,calc((100%-700px)/2))] rounded-lg bg-red/10 px-3 py-2 text-sm text-red-foreground motion-safe:animate-rise-in motion-reduce:animate-fade-in"
    >
      {bot.name} couldn't reach its model: {bot.error}. Check its provider in{' '}
      <Link to="/settings/providers" className="underline">
        Settings
      </Link>
      , then send your message again.
    </p>
  )
}
