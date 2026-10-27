import type { BotInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { ChatView } from '../../components/chat-view.tsx'
import { ProfilePane } from '../../components/profile-pane.tsx'
import { FullscreenScreen, ScreenPane } from '../../components/screen-pane.tsx'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/bots/$botId')({
  component: Dm,
})

/** The right-hand pane beside a DM: one at a time, the bot's screen by default. */
type Pane = 'screen' | 'profile'

/** The DM between the owner and one bot, in Grok Bot's layout, with its Screen or Profile pane beside it. */
function Dm() {
  const { botId } = Route.useParams()
  const live = useLive()
  const navigate = useNavigate()
  const [pane, setPane] = useState<Pane | null>('screen')
  /** Whether the bot's screen is fullscreen, where the owner controls it; another bot's starts closed. */
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => setFullscreen(false), [botId])
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
          header={<DmHeader bot={bot} pane={pane} onTogglePane={(next) => setPane((open) => (open === next ? null : next))} />}
          notice={bot.error && !bot.working && <ModelError bot={bot} />}
          composerLabel={`Message ${bot.name}`}
          emptyText={`Say hi to ${bot.name}.`}
          typing={bot.working ? bot : undefined}
          stopBot={bot}
          allowFiles
          showAuthors={false}
          onScreen={() => setFullscreen(true)}
        />
      </div>
      {pane === 'screen' && <ScreenPane bot={bot} takeOver={waitingTakeOver} onOpen={() => setFullscreen(true)} />}
      {fullscreen && <FullscreenScreen bot={bot} takeOver={waitingTakeOver} onClose={closeFullscreen} />}
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

/** The DM's bar: the bot, whether it works, and the pane toggles. */
function DmHeader({ bot, pane, onTogglePane }: { bot: BotInfo; pane: Pane | null; onTogglePane: (pane: Pane) => void }) {
  return (
    <header className="chat-material sticky top-0 z-10 flex min-h-[51px] items-center gap-2 px-4">
      <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} />
      <span className="font-semibold">{bot.name}</span>
      {bot.working && <span className="animate-fade-in text-sm text-muted-foreground">Working</span>}
      <span className="ml-auto flex gap-1">
        {(['screen', 'profile'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={pane === choice}
            onClick={() => onTogglePane(choice)}
            className={cn('pressable rounded-md px-2 py-1 text-base hover:bg-secondary-hover', pane === choice && 'bg-selected')}
          >
            {choice === 'screen' ? 'Screen' : 'Profile'}
          </button>
        ))}
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
