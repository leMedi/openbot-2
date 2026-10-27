import { type BotInfo, type MessageInfo, maxAttachmentBytes, maxAttachments } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Attachments, FileIcon, formatSize } from '../../components/attachments.tsx'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { Markdown } from '../../components/markdown.tsx'
import { ProfilePane } from '../../components/profile-pane.tsx'
import { QuestionCard } from '../../components/question-card.tsx'
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
  files: File[]
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
  /** The server's message, when it has one; a card and attachments render from it. */
  message?: MessageInfo
}

/** Files the owner added to each chat's composer and hasn't sent yet, kept while they switch chats. */
const pendingFiles = new Map<string, File[]>()

/** Adds `added` to `files`, up to Grok's 6; returns them and why any were left out. */
function addFiles(files: File[], added: File[]): { files: File[]; notice?: string } {
  const tooLarge = added.filter((file) => file.size > maxAttachmentBytes)
  const fitting = added.filter((file) => file.size <= maxAttachmentBytes)
  const next = [...files, ...fitting].slice(0, maxAttachments)
  if (tooLarge.length) return { files: next, notice: `${tooLarge[0]!.name} is larger than ${maxAttachmentBytes / 1024 / 1024} MB` }
  if (files.length + fitting.length > maxAttachments) return { files: next, notice: `You can attach up to ${maxAttachments} files` }
  return { files: next }
}

/** The DM between the owner and one bot, in Grok Bot's layout, with its Profile pane beside it when open. */
function Dm() {
  const { botId } = Route.useParams()
  const live = useLive()
  const navigate = useNavigate()
  const [profileOpen, setProfileOpen] = useState(false)
  const bot = live.bots?.find((entry) => entry.id === botId)
  if (!bot) return live.bots ? <p className="m-auto text-muted-foreground">This bot doesn't exist.</p> : null
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Keyed, so loading state, scroll position and sends in flight belong to one chat. */}
        <Chat key={bot.chatId} bot={bot} profileOpen={profileOpen} onToggleProfile={() => setProfileOpen((open) => !open)} />
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

function Chat({ bot, profileOpen, onToggleProfile }: { bot: BotInfo; profileOpen: boolean; onToggleProfile: () => void }) {
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
  const [files, setFilesState] = useState<File[]>(() => pendingFiles.get(bot.chatId) ?? [])
  const [notice, setNotice] = useState<string>()
  const [dragging, setDragging] = useState(false)
  /** Nested elements fire their own enter and leave; the overlay stays until the drag leaves them all. */
  const dragDepth = useRef(0)

  function setFiles(next: File[]) {
    setFilesState(next)
    if (next.length) pendingFiles.set(bot.chatId, next)
    else pendingFiles.delete(bot.chatId)
  }

  function attach(added: File[]) {
    if (!added.length) return
    const result = addFiles(files, added)
    setFiles(result.files)
    setNotice(result.notice)
  }

  useEffect(() => {
    live.openChat(bot.chatId).then(
      () => setLoaded(true),
      (caught) => setError(errorMessage(caught)),
    )
  }, [bot.chatId, live])

  const messages = live.messages.get(bot.chatId) ?? []
  if (loaded && !history.current) history.current = new Set(messages.map((message) => message.id))

  // The owner is reading this chat: what arrives while it's open, and in view, is read too.
  const newest = messages.at(-1)?.id
  const unread = live.chats.get(bot.chatId)?.unread ?? false
  /** The newest message a read was tried for; a failed one isn't retried until another message arrives. */
  const triedRead = useRef<string>(undefined)
  useEffect(() => {
    if (!loaded || !unread) return
    const markRead = () => {
      if (document.visibilityState !== 'visible' || triedRead.current === newest) return
      triedRead.current = newest
      // A failure leaves the chat unread, as the server has it; nothing for the owner to do.
      live.markRead(bot.chatId, newest).catch(() => {})
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => document.removeEventListener('visibilitychange', markRead)
  }, [loaded, unread, newest, bot.chatId, live])

  async function send(text: string, files: File[], key: string = crypto.randomUUID()) {
    following.current = true
    const after = messages.at(-1)?.id
    setOutgoing((list) => [...list.filter((entry) => entry.key !== key), { key, text, files, after }])
    try {
      live.addMessage(await api().chats.send({ chatId: bot.chatId, text, files }))
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
      message,
    })),
    ...outgoing
      // The live stream can deliver the server's copy before the send returns.
      .filter(
        (entry) =>
          !messages.some(
            (message) =>
              message.author === 'owner' &&
              message.text === entry.text &&
              message.attachments.map((file) => file.size).join() === entry.files.map((file) => file.size).join() &&
              (!entry.after || message.id > entry.after),
          ),
      )
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
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        attach([...event.dataTransfer.files])
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-blue bg-blue-subtle/60 motion-safe:animate-fade-in">
          <span className="rounded-full bg-blue px-3 py-1.5 text-sm font-medium text-white shadow-md">Drop files to add to chat</span>
        </div>
      )}
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
            <button
              type="button"
              aria-pressed={profileOpen}
              onClick={onToggleProfile}
              className={cn('pressable ml-auto rounded-md px-2 py-1 text-base hover:bg-secondary-hover', profileOpen && 'bg-selected')}
            >
              Profile
            </button>
          </header>
          <MessageList
            bot={bot}
            rows={rows}
            loading={!loaded && !error}
            onResend={(entry) => void send(entry.text, entry.files, entry.key)}
            onDiscard={(entry) => setOutgoing((list) => list.filter((other) => other.key !== entry.key))}
            onAnswered={(message) => live.addMessage(message)}
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
      <Composer
        bot={bot}
        files={files}
        notice={notice}
        onAttach={attach}
        onRemove={(file) => {
          setFiles(files.filter((other) => other !== file))
          setNotice(undefined)
        }}
        onSend={(text) => {
          const sending = files
          setFiles([])
          setNotice(undefined)
          void send(text, sending)
        }}
      />
    </div>
  )
}

function MessageList({
  bot,
  rows,
  loading,
  onResend,
  onDiscard,
  onAnswered,
}: {
  bot: BotInfo
  rows: Row[]
  loading: boolean
  onResend: (entry: Outgoing) => void
  onDiscard: (entry: Outgoing) => void
  onAnswered: (message: MessageInfo) => void
}) {
  // Letter keys answer the newest open question only.
  const newestOpenQuestion = [...rows].reverse().find((row) => row.message?.card?.type === 'question' && !row.message.card.answer)?.key
  return (
    <div className="px-[max(30px,calc((100%-690px)/2))] pt-2 pb-7">
      {loading && <p className="text-center text-muted-foreground">Loading…</p>}
      {!loading && rows.length === 0 && <p className="text-center text-muted-foreground">Say hi to {bot.name}.</p>}
      {rows.map((row, index) => {
        // Consecutive messages of one author sit close together, with tighter corners on the sender's side.
        const continuesPrevious = rows[index - 1]?.author === row.author
        const continuesNext = rows[index + 1]?.author === row.author
        const failed = row.outgoing?.error
        const card = row.message?.card
        if (card?.type === 'question') {
          return (
            <div
              key={row.key}
              role="article"
              className={cn(
                'max-w-[min(88%,520px)] origin-bottom-left',
                continuesNext ? 'mb-1' : 'mb-[22px]',
                row.enter && 'motion-safe:animate-message-in motion-reduce:animate-fade-in',
              )}
            >
              <span className="sr-only">{row.authorName}: </span>
              <QuestionCard message={row.message!} card={card} letterKeys={row.key === newestOpenQuestion} onAnswered={onAnswered} />
            </div>
          )
        }
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
              {row.message && row.message.attachments.length > 0 && (
                <Attachments messageId={row.message.id} attachments={row.message.attachments} mine={row.mine} />
              )}
              {row.outgoing && row.outgoing.files.length > 0 && (
                <div className={cn('flex max-w-full flex-wrap justify-end gap-1', failed && 'opacity-60')}>
                  {row.outgoing.files.map((file, index) => (
                    <FileChip key={index} file={file} />
                  ))}
                </div>
              )}
              {/* Grok doesn't bubble a message of files only. */}
              {row.text && (
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
              )}
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

/** A file waiting in the composer, or going out with a message: Grok's 210px chip with its name and size. */
function FileChip({ file, onRemove }: { file: File; onRemove?: () => void }) {
  return (
    <span className="flex max-w-[210px] items-center gap-1.5 rounded-[10px] border border-border bg-card py-1.5 pr-1.5 pl-2 motion-safe:animate-pop-in motion-reduce:animate-fade-in">
      <FileIcon />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[10px] font-medium">{file.name}</span>
        <span className="text-[9px] text-muted-foreground tabular-nums">{formatSize(file.size)}</span>
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onClick={onRemove}
          className="pressable grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
        >
          ×
        </button>
      )}
    </span>
  )
}

/**
 * Writes to the bot. A message sent while it works steers the current run; with nothing typed or attached, the button
 * stops the run instead. Files come from the + button, a paste, or a drop anywhere on the chat. The chat's unsent text
 * is kept by the live store, so switching chats doesn't lose it.
 */
function Composer({
  bot,
  files,
  notice,
  onAttach,
  onRemove,
  onSend,
}: {
  bot: BotInfo
  files: File[]
  notice: string | undefined
  onAttach: (files: File[]) => void
  onRemove: (file: File) => void
  onSend: (text: string) => void
}) {
  const live = useLive()
  const text = live.drafts.get(bot.chatId) ?? ''
  const [error, setError] = useState<string>()
  const [stopping, setStopping] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  function send() {
    const draft = text.trim()
    if (!draft && !files.length) return
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

  const canStop = bot.working && !text.trim() && !files.length

  return (
    <div className="px-[max(24px,calc((100%-700px)/2))] pt-2 pb-[18px]">
      {error && <p className="pb-1 text-sm text-destructive-foreground">{error}</p>}
      {notice && <p className="pb-1 text-[10px] text-muted-foreground">{notice}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
        className="flex flex-col gap-2 rounded-2xl border border-border bg-secondary p-[9px] shadow-sm transition-colors duration-100 focus-within:border-border-strong"
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((file, index) => (
              <FileChip key={`${file.name}:${file.size}:${index}`} file={file} onRemove={() => onRemove(file)} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              onAttach([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            disabled={files.length >= maxAttachments}
            onClick={() => picker.current?.click()}
            className="pressable grid size-[30px] shrink-0 place-items-center rounded-full bg-background text-foreground hover:bg-secondary-hover disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <textarea
            aria-label={`Message ${bot.name}`}
            placeholder={`Message ${bot.name}`}
            rows={2}
            value={text}
            onChange={(event) => live.setDraft(bot.chatId, event.target.value)}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files]
              if (!pasted.length) return
              event.preventDefault()
              onAttach(pasted)
            }}
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
            <button type="submit" aria-label="Send" disabled={!text.trim() && !files.length} className={roundButton}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
              </svg>
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
