import type { BotInfo } from '@openbot/api-contract'
import { useLive, waitingTakeOver } from '@openbot/client'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AccessPane } from '../../components/access-pane.tsx'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { ChatView } from '../../components/chat-view.tsx'
import { MemoryPane } from '../../components/memory-pane.tsx'
import { ProfilePane } from '../../components/profile-pane.tsx'
import { RoutinesPane, type RoutineToOpen } from '../../components/routines-pane.tsx'
import { FullscreenScreen, ScreenPane } from '../../components/screen-pane.tsx'
import { BackToChats, PanelToggle, SidePanel } from '../../components/side-panel.tsx'
import { type ChatSearch, chatSearch } from '../../lib/chat-search.ts'
import { usePhone } from '../../lib/sidebar-prefs.ts'

export const Route = createFileRoute('/_app/bots/$botId')({
  validateSearch: chatSearch,
  component: Dm,
})

/** The tabs of the panel beside a DM, the bot's screen first. */
type Pane = 'screen' | 'profile' | 'routines' | 'memory' | 'access'

const panes: readonly { id: Pane; label: string }[] = [
  { id: 'screen', label: 'Screen' },
  { id: 'profile', label: 'Profile' },
  { id: 'routines', label: 'Routines' },
  { id: 'memory', label: 'Memory' },
  { id: 'access', label: 'Access' },
]

/**
 * The DM between the owner and one bot, in Grok Bot's layout, with its panel beside it: Screen, Profile, Routines,
 * Memory and Access as tabs, shown and hidden from the header. It starts open on the screen, except on a phone, where
 * it would cover the chat.
 */
function Dm() {
  const { botId } = Route.useParams()
  const search = Route.useSearch()
  const live = useLive()
  const navigate = useNavigate()
  const phone = usePhone()
  const [pane, setPane] = useState<Pane>('screen')
  const [panelOpen, setPanelOpen] = useState(() => !phone)
  function openPane(next: Pane) {
    setPane(next)
    setPanelOpen(true)
  }
  /** The routine a timeline chip asked the Routines pane to open. */
  const [routineToOpen, setRoutineToOpen] = useState<RoutineToOpen>()
  /** Whether the bot's screen is fullscreen, where the owner controls it; another bot's starts closed. */
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    setFullscreen(false)
    setRoutineToOpen(undefined)
  }, [botId])
  // A routine the palette opened: shown once, then out of the URL.
  useEffect(() => {
    if (!search.routine) return
    setRoutineToOpen({ routineId: search.routine, requestedAt: Date.now() })
    openPane('routines')
    void navigate({ to: '.', search: (previous: ChatSearch) => ({ ...previous, routine: undefined }), replace: true })
  }, [search.routine, navigate])
  const bot = live.bots?.find((entry) => entry.id === botId)
  const takeOver = bot && waitingTakeOver(live.messages.get(bot.chatId) ?? [])?.message
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
          focusMessage={search.message}
          onFocused={() => void navigate({ to: '.', search: (previous: ChatSearch) => ({ ...previous, message: undefined }), replace: true })}
          header={
<DmHeader bot={bot} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((open) => !open)} />
          }
          notice={bot.error && !bot.working && <ModelError bot={bot} />}
          composerLabel={`Message ${bot.name}`}
          emptyText={`Say hi to ${bot.name}.`}
          typing={bot.working ? bot : undefined}
          allowFiles
          showAuthors={false}
          covered={fullscreen}
          onScreen={() => setFullscreen(true)}
          onOpenRoutine={(routineId) => {
            setRoutineToOpen({ routineId, requestedAt: Date.now() })
            openPane('routines')
          }}
        />
      </div>
      {panelOpen && (
        <SidePanel
          label={`${bot.name}'s panel`}
          tabs={panes}
          tab={pane}
          onTab={(next) => {
            setRoutineToOpen(undefined)
            setPane(next)
          }}
          onClose={() => setPanelOpen(false)}
        >
          {pane === 'screen' && <ScreenPane bot={bot} takeOver={takeOver} onOpen={() => setFullscreen(true)} />}
          {pane === 'memory' && <MemoryPane bot={bot} />}
          {pane === 'access' && <AccessPane key={bot.id} bot={bot} />}
          {pane === 'routines' && <RoutinesPane key={bot.id} bot={bot} open={routineToOpen} />}
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
        </SidePanel>
      )}
      {fullscreen && <FullscreenScreen bot={bot} takeOver={takeOver} onClose={closeFullscreen} />}
    </div>
  )
}

/** The DM's bar: the way back to the chats on a phone, the bot, whether it works, and the panel's toggle. */
function DmHeader({ bot, panelOpen, onTogglePanel }: { bot: BotInfo; panelOpen: boolean; onTogglePanel: () => void }) {
  return (
    <header className="chat-material sticky top-0 z-10 flex min-h-[51px] items-center gap-2 px-4">
      <BackToChats />
      <BotAvatar style={bot.avatarStyle} shape={bot.avatarShape} color={bot.avatarColor} />
      <span className="truncate font-semibold">{bot.name}</span>
      {bot.working && <span className="shrink-0 animate-fade-in text-sm text-muted-foreground">Working</span>}
      <span className="ml-auto flex shrink-0 gap-1">
        <PanelToggle open={panelOpen} onToggle={onTogglePanel} />
      </span>
    </header>
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
