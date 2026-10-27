import type { BotInfo, MessageInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { Markdown } from '../../components/markdown.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/bots/$botId')({
  component: Dm,
})

/** How close to the end still counts as reading the latest messages. */
const followThresholdPx = 80

/** A message the owner sent that the server hasn't returned yet, or that failed. */
type Outgoing = {
  key: string
  text: string
  /** The chat's last message id when it was sent; the server's copy sorts after it. */
  after: string | undefined
  error?: string
}

type Row = {
  key: string
  author: string
  authorName: string
  mine: boolean
  text: string
  /** Arrived while the chat was open, so it animates in. */
  enter: boolean
  outgoing?: Outgoing
}

/** The DM between the owner and one bot, in Grok Bot's layout. */
function Dm() {
  const { botId } = Route.useParams()
  const live = useLive()
  const bot = live.bots?.find((entry) => entry.id === botId)
  if (!bot) return live.bots ? <p className="m-auto text-muted-foreground">This bot doesn't exist.</p> : null
  // Keyed, so loading state, scroll position and sends in flight belong to one chat.
  return <Chat key={bot.chatId} bot={bot} />
}

function Chat({ bot }: { bot: BotInfo }) {
  const live = useLive()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  /** Whether the view follows new messages; false once the owner scrolls up to read. */
  const following = useRef(true)
  const [unseen, setUnseen] = useState(false)
  /** Messages already there when the chat loaded; they don't animate. */
  const history = useRef<Set<string>>(undefined)

  useEffect(() => {
    live.openChat(bot.chatId).then(
      () => setLoaded(true),
      (caught) => setError(errorMessage(caught)),
    )
  }, [bot.chatId, live])

  const messages = live.messages.get(bot.chatId) ?? []
  if (loaded && !history.current) history.current = new Set(messages.map((message) => message.id))

  async function send(text: string, key: string = crypto.randomUUID()) {
    following.current = true
    const after = messages.at(-1)?.id
    setOutgoing((list) => [...list.filter((entry) => entry.key !== key), { key, text, after }])
    try {
      live.addMessage(await api().chats.send({ chatId: bot.chatId, text }))
      setOutgoing((list) => list.filter((entry) => entry.key !== key))
    } catch (caught) {
      setOutgoing((list) => list.map((entry) => (entry.key === key ? { ...entry, error: errorMessage(caught) } : entry)))
    }
  }

  const rows: Row[] = [
    ...messages.map((message: MessageInfo) => ({
      key: message.id,
      author: message.author === 'owner' ? 'owner' : `bot:${message.botId}`,
      authorName: message.authorName,
      mine: message.author === 'owner',
      text: message.text,
      // The owner's own messages already animated in as outgoing ones.
      enter: !!history.current && !history.current.has(message.id) && message.author !== 'owner',
    })),
    ...outgoing
      // The live stream can deliver the server's copy before the send returns.
      .filter((entry) => !messages.some((message) => message.author === 'owner' && message.text === entry.text && (!entry.after || message.id > entry.after)))
      .map((entry) => ({ key: entry.key, author: 'owner', authorName: 'You', mine: true, text: entry.text, enter: true, outgoing: entry })),
  ]

  // Follow new messages only while the owner is at the end; otherwise offer to jump there.
  const rowCount = useRef(rows.length)
  useLayoutEffect(() => {
    const element = scroller.current
    const grew = rows.length > rowCount.current
    rowCount.current = rows.length
    if (!element) return
    if (following.current) element.scrollTop = element.scrollHeight
    else if (grew) setUnseen(true)
  }, [rows.length, bot.working])

  // The composer growing shrinks the transcript; keep the end in view.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function jumpToEnd() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < followThresholdPx
            if (following.current) setUnseen(false)
          }}
          className="chat-scroll flex-1 overflow-y-auto"
        >
          <header className="chat-material sticky top-0 z-10 flex min-h-[51px] items-center gap-2 px-4">
            <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} />
            <span className="font-semibold">{bot.name}</span>
            {bot.working && <span className="animate-fade-in text-sm text-muted-foreground">Working</span>}
          </header>
          <MessageList
            bot={bot}
            rows={rows}
            loading={!loaded && !error}
            onResend={(entry) => void send(entry.text, entry.key)}
            onDiscard={(entry) => setOutgoing((list) => list.filter((other) => other.key !== entry.key))}
          />
        </div>
        {unseen && (
          <button
            type="button"
            onClick={jumpToEnd}
            className="pressable absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 text-sm shadow-md hover:bg-muted motion-safe:animate-rise-in motion-reduce:animate-fade-in"
          >
            New messages ↓
          </button>
        )}
      </div>
      {error && <p className="px-6 text-destructive-foreground">{error}</p>}
      {bot.error && !bot.working && (
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
      )}
      <Composer bot={bot} onSend={(text) => void send(text)} />
    </>
  )
}

function MessageList({
  bot,
  rows,
  loading,
  onResend,
  onDiscard,
}: {
  bot: BotInfo
  rows: Row[]
  loading: boolean
  onResend: (entry: Outgoing) => void
  onDiscard: (entry: Outgoing) => void
}) {
  return (
    <div className="px-[max(30px,calc((100%-690px)/2))] pt-2 pb-7">
      {loading && <p className="text-center text-muted-foreground">Loading…</p>}
      {!loading && rows.length === 0 && <p className="text-center text-muted-foreground">Say hi to {bot.name}.</p>}
      {rows.map((row, index) => {
        // Consecutive messages of one author sit close together, with tighter corners on the sender's side.
        const continuesPrevious = rows[index - 1]?.author === row.author
        const continuesNext = rows[index + 1]?.author === row.author
        const failed = row.outgoing?.error
        return (
          <div key={row.key} role="article" className={cn('flex', row.mine && 'justify-end', continuesNext ? 'mb-1' : 'mb-[22px]')}>
            <span className="sr-only">{row.authorName}: </span>
            <div
              className={cn(
                'flex max-w-[min(88%,640px)] min-w-0 flex-col gap-1',
                row.mine ? 'origin-bottom-right items-end' : 'origin-bottom-left items-start',
                row.enter && 'motion-safe:animate-message-in motion-reduce:animate-fade-in',
              )}
            >
              <div
                className={cn(
                  'max-w-full rounded-[18px] px-3 py-2 text-base/5 transition-opacity duration-100 [overflow-wrap:anywhere]',
                  row.mine ? 'bg-bubble-user text-on-color' : 'bg-bubble-agent',
                  row.mine
                    ? [continuesPrevious && 'rounded-tr-[6px]', continuesNext && 'rounded-br-[6px]']
                    : [continuesPrevious && 'rounded-tl-[6px]', continuesNext && 'rounded-bl-[6px]'],
                  failed && 'opacity-60',
                )}
              >
                <Markdown text={row.text} onColor={row.mine} />
              </div>
              {failed && row.outgoing && (
                <p role="alert" className="flex gap-2 text-sm text-destructive-foreground motion-safe:animate-rise-in motion-reduce:animate-fade-in">
                  <span title={failed}>Failed to send</span>
                  <button type="button" onClick={() => onResend(row.outgoing!)} className="pressable font-medium underline underline-offset-2">
                    Resend
                  </button>
                  <button type="button" onClick={() => onDiscard(row.outgoing!)} className="pressable font-medium underline underline-offset-2">
                    Delete
                  </button>
                </p>
              )}
            </div>
          </div>
        )
      })}
      {bot.working && (
        <div
          aria-label={`${bot.name} is working`}
          className="mb-[22px] inline-flex origin-bottom-left gap-1 rounded-[14px] bg-bubble-agent px-3 py-2.5 motion-safe:animate-message-in motion-reduce:animate-fade-in"
        >
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="size-[5px] rounded-full bg-muted-foreground motion-safe:animate-typing motion-reduce:animate-typing-fade"
              style={{ animationDelay: `${dot * 160}ms` }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const roundButton =
  'pressable grid size-[30px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-40'

/**
 * Writes to the bot. A message sent while it works steers the current run; with nothing typed, the button stops the
 * run instead. The chat's unsent text is kept by the live store, so switching chats doesn't lose it.
 */
function Composer({ bot, onSend }: { bot: BotInfo; onSend: (text: string) => void }) {
  const live = useLive()
  const text = live.drafts.get(bot.chatId) ?? ''
  const [error, setError] = useState<string>()
  const [stopping, setStopping] = useState(false)

  function send() {
    const draft = text.trim()
    if (!draft) return
    live.setDraft(bot.chatId, '')
    onSend(draft)
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

  const canStop = bot.working && !text.trim()

  return (
    <div className="px-[max(24px,calc((100%-700px)/2))] pt-2 pb-[18px]">
      {error && <p className="pb-1 text-sm text-destructive-foreground">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
        className="flex items-end gap-2 rounded-2xl border border-border bg-secondary p-[9px] shadow-sm transition-colors duration-100 focus-within:border-border-strong"
      >
        <textarea
          aria-label={`Message ${bot.name}`}
          placeholder={`Message ${bot.name}`}
          rows={2}
          value={text}
          onChange={(event) => live.setDraft(bot.chatId, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          className="max-h-60 min-h-12 flex-1 resize-none bg-transparent px-1 leading-[1.4] outline-none [field-sizing:content]"
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
            <span className="size-2.5 rounded-[2px] bg-current motion-safe:animate-pop-in motion-reduce:animate-fade-in" />
          </button>
        ) : (
          <button type="submit" aria-label="Send" disabled={!text.trim()} className={roundButton}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        )}
      </form>
    </div>
  )
}
