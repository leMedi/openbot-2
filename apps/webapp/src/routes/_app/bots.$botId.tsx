import type { BotInfo, MessageInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { Markdown } from '../../components/markdown.tsx'
import { ProfilePane } from '../../components/profile-pane.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/bots/$botId')({
  component: Dm,
})

/** The DM between the owner and one bot, in Grok Bot's layout, with its Profile pane beside it when open. */
function Dm() {
  const { botId } = Route.useParams()
  const live = useLive()
  const navigate = useNavigate()
  const [profileOpen, setProfileOpen] = useState(false)
  const bot = live.bots?.find((entry) => entry.id === botId)
  const [error, setError] = useState<string>()
  const [loadedChat, setLoadedChat] = useState<string>()

  const chatId = bot?.chatId
  useEffect(() => {
    if (!chatId) return
    setError(undefined)
    live.openChat(chatId).then(
      () => setLoadedChat(chatId),
      (caught) => setError(errorMessage(caught)),
    )
  }, [chatId, live])

  if (!bot) return live.bots ? <p className="m-auto text-muted-foreground">This bot doesn't exist.</p> : null
  const messages = live.messages.get(bot.chatId)
  const loading = loadedChat !== bot.chatId && !error

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[51px] items-center gap-2 border-b border-border-subtle px-4">
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} />
          <span className="font-semibold">{bot.name}</span>
          {bot.working && <span className="text-sm text-muted-foreground">Working</span>}
          <button
            type="button"
            aria-pressed={profileOpen}
            onClick={() => setProfileOpen((open) => !open)}
            className={cn('ml-auto rounded-md px-2 py-1 text-base hover:bg-secondary-hover', profileOpen && 'bg-selected')}
          >
            Profile
          </button>
        </header>
        <MessageList bot={bot} messages={messages ?? []} loading={loading} />
        {error && <p className="px-6 text-destructive-foreground">{error}</p>}
        {bot.error && !bot.working && (
          <p role="alert" className="mx-[max(24px,calc((100%-700px)/2))] rounded-lg bg-red/10 px-3 py-2 text-sm text-red-foreground">
            {bot.name} couldn't reach its model: {bot.error}. Check its provider in{' '}
            <Link to="/settings/providers" className="underline">
              Settings
            </Link>
            , then send your message again.
          </p>
        )}
        <Composer
          bot={bot}
          draft={live.drafts.get(bot.chatId) ?? ''}
          onDraft={(text) => live.setDraft(bot.chatId, text)}
          onSent={(message) => live.addMessage(message)}
        />
      </div>
      {profileOpen && (
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

function MessageList({ bot, messages, loading }: { bot: BotInfo; messages: MessageInfo[]; loading: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, bot.working])

  return (
    <div className="flex-1 overflow-y-auto px-[max(30px,calc((100%-690px)/2))] py-7">
      {loading && <p className="text-center text-muted-foreground">Loading…</p>}
      {!loading && messages.length === 0 && <p className="text-center text-muted-foreground">Say hi to {bot.name}.</p>}
      {messages.map((message, index) => {
        const mine = message.author === 'owner'
        // Consecutive messages of one author sit close together.
        const groupEnd = messages[index + 1]?.author !== message.author
        return (
          <div key={message.id} role="article" className={cn('flex', mine && 'justify-end', groupEnd ? 'mb-[22px]' : 'mb-1')}>
            <span className="sr-only">{message.authorName}: </span>
            <div
              className={cn(
                'max-w-[min(88%,640px)] rounded-[18px] px-3 py-2 text-base/5 [overflow-wrap:anywhere]',
                mine ? 'bg-bubble-user text-on-color' : 'bg-bubble-agent',
              )}
            >
              <Markdown text={message.text} onColor={mine} />
            </div>
          </div>
        )
      })}
      {bot.working && (
        <div aria-label={`${bot.name} is working`} className="mb-[22px] inline-flex gap-1 rounded-[14px] bg-bubble-agent px-3 py-2.5">
          {[0, 1, 2].map((dot) => (
            <span key={dot} className="size-[5px] animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${dot * 150}ms` }} />
          ))}
        </div>
      )}
      <div ref={end} />
    </div>
  )
}

const roundButton = 'grid size-[30px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40'

/**
 * Writes to the bot. A message sent while it works steers the current run; with nothing typed, the button stops the
 * run instead.
 */
function Composer({
  bot,
  draft,
  onDraft,
  onSent,
}: {
  bot: BotInfo
  /** The chat's unsent text, kept by the live store so switching chats doesn't lose it. */
  draft: string
  onDraft: (text: string) => void
  onSent: (message: MessageInfo) => void
}) {
  const [error, setError] = useState<string>()
  const [stopping, setStopping] = useState(false)
  // Errors belong to the chat they happened in.
  useEffect(() => setError(undefined), [bot.chatId])

  async function send() {
    const text = draft.trim()
    if (!text) return
    onDraft('')
    setError(undefined)
    try {
      onSent(await api().chats.send({ chatId: bot.chatId, text }))
    } catch (caught) {
      onDraft(text)
      setError(errorMessage(caught))
    }
  }

  async function stop() {
    setStopping(true)
    setError(undefined)
    try {
      await api().bots.stop({ botId: bot.id })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setStopping(false)
    }
  }

  const canStop = bot.working && !draft.trim()

  return (
    <div className="px-[max(24px,calc((100%-700px)/2))] pt-2 pb-[18px]">
      {error && <p className="pb-1 text-sm text-destructive-foreground">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
        className="flex items-end gap-2 rounded-2xl border border-border bg-secondary p-[9px] shadow-sm"
      >
        <textarea
          aria-label={`Message ${bot.name}`}
          placeholder={`Message ${bot.name}`}
          rows={2}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
          className="max-h-60 min-h-12 flex-1 resize-none bg-transparent px-1 leading-[1.4] outline-none"
        />
        {canStop ? (
          <button
            type="button"
            aria-label={`Stop ${bot.name}`}
            title="Stop"
            disabled={stopping}
            onClick={() => void stop()}
            className={roundButton}
          >
            <span className="size-2.5 rounded-[2px] bg-current" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={!draft.trim()}
            className={roundButton}
          >
            ↑
          </button>
        )}
      </form>
    </div>
  )
}
