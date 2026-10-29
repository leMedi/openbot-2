import { type BotInfo, type BotMessageInfo, type MessageInfo, type RoutineChangeCardInfo, maxAttachmentBytes, maxAttachments } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { useLive } from '../lib/live.tsx'
import { Attachments, FileIcon, formatSize } from './attachments.tsx'
import { Markdown } from './markdown.tsx'
import { PluginReconnectCard } from './plugin-reconnect-card.tsx'
import { PluginRequestCard } from './plugin-request-card.tsx'
import { QuestionCard } from './question-card.tsx'
import { TakeOverCard } from './take-over-card.tsx'

/** How close to the end still counts as reading the latest messages. */
const followThresholdPx = 80

/** How long a message the palette opened stays highlighted. */
const highlightMs = 2000

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

/**
 * A chat's transcript and composer, for a DM or a group chat: messages arrive live, the view follows them while the owner
 * is at the end, the chat is marked read as it is read, and files can be dropped anywhere on it.
 */
export function ChatView({
  chatId,
  header,
  notice: banner,
  composerLabel,
  emptyText,
  typing,
  allowFiles,
  showAuthors,
  onScreen,
  onOpenRoutine,
  focusMessage,
  onFocused,
}: {
  chatId: string
  /** The sticky bar at the top of the transcript. */
  header: ReactNode
  /** Shown above the composer, e.g. why the bot couldn't answer. */
  notice?: ReactNode
  /** The composer's label and placeholder, e.g. "Message Rex". */
  composerLabel: string
  /** Shown while the chat has no messages. */
  emptyText: string
  /** The bot shown typing at the end: a DM's bot while it works, a group's member taking its turn. */
  typing: BotInfo | undefined
  /** Whether the owner can attach files. */
  allowFiles: boolean
  /** Shows each bot's name above its messages, as in a group chat. */
  showAuthors: boolean
  /** Opens the bot's screen fullscreen, where the owner controls it, from a take-over card; DMs only. */
  onScreen?: () => void
  /** Opens a routine in the Routines pane, from a timeline row's clock chip; DMs only. */
  onOpenRoutine?: (routineId: string) => void
  /** A message to scroll to and highlight once the chat has loaded, e.g. a search hit the palette opened. */
  focusMessage?: string
  /** The view went to `focusMessage` (or it isn't in this chat). */
  onFocused?: () => void
}) {
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
  const [files, setFilesState] = useState<File[]>(() => pendingFiles.get(chatId) ?? [])
  const [notice, setNotice] = useState<string>()
  const [dragging, setDragging] = useState(false)
  /** Nested elements fire their own enter and leave; the overlay stays until the drag leaves them all. */
  const dragDepth = useRef(0)

  function setFiles(next: File[]) {
    setFilesState(next)
    if (next.length) pendingFiles.set(chatId, next)
    else pendingFiles.delete(chatId)
  }

  function attach(added: File[]) {
    if (!added.length || !allowFiles) return
    const result = addFiles(files, added)
    setFiles(result.files)
    setNotice(result.notice)
  }

  useEffect(() => {
    live.openChat(chatId).then(
      () => setLoaded(true),
      (caught) => setError(errorMessage(caught)),
    )
  }, [chatId, live])

  const messages = live.messages.get(chatId) ?? []
  if (loaded && !history.current) history.current = new Set(messages.map((message) => message.id))

  // The owner is reading this chat: what arrives while it's open, and in view, is read too.
  const newest = messages.at(-1)?.id
  const unread = live.chats.get(chatId)?.unread ?? false
  /** The newest message a read was tried for; a failed one isn't retried until another message arrives. */
  const triedRead = useRef<string>(undefined)
  useEffect(() => {
    if (!loaded || !unread) return
    const markRead = () => {
      if (document.visibilityState !== 'visible' || triedRead.current === newest) return
      triedRead.current = newest
      // A failure leaves the chat unread, as the server has it; nothing for the owner to do.
      live.markRead(chatId, newest).catch(() => {})
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => document.removeEventListener('visibilitychange', markRead)
  }, [loaded, unread, newest, chatId, live])

  async function send(text: string, files: File[], key: string = crypto.randomUUID()) {
    following.current = true
    const after = messages.at(-1)?.id
    setOutgoing((list) => [...list.filter((entry) => entry.key !== key), { key, text, files, after }])
    try {
      live.addMessage(await api().chats.send({ chatId, text, files }))
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
  }, [rows.length, typing])

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

  // Goes to the message the palette opened, highlighting it a moment; declared after following, so it wins.
  const [highlighted, setHighlighted] = useState<string>()
  const focused = useRef(onFocused)
  focused.current = onFocused
  useLayoutEffect(() => {
    if (!loaded || !focusMessage) return
    const element = scroller.current?.querySelector(`[data-message-id="${CSS.escape(focusMessage)}"]`)
    if (element) {
      following.current = false
      element.scrollIntoView({ block: 'center' })
      setHighlighted(focusMessage)
    }
    focused.current?.()
  }, [loaded, focusMessage])
  useEffect(() => {
    if (!highlighted) return
    const timer = setTimeout(() => setHighlighted(undefined), highlightMs)
    return () => clearTimeout(timer)
  }, [highlighted])

  function jumpToEnd() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (!allowFiles || !event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (allowFiles && event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={(event) => {
        if (!allowFiles || !event.dataTransfer.types.includes('Files')) return
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
          {header}
          <MessageList
            rows={rows}
            emptyText={emptyText}
            typing={typing}
            showAuthors={showAuthors}
            loading={!loaded && !error}
            highlighted={highlighted}
            onResend={(entry) => void send(entry.text, entry.files, entry.key)}
            onDiscard={(entry) => setOutgoing((list) => list.filter((other) => other.key !== entry.key))}
            onAnswered={(message) => live.addMessage(message)}
            onScreen={onScreen}
            onOpenRoutine={onOpenRoutine}
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
      {banner}
      <Composer
        chatId={chatId}
        label={composerLabel}
        allowFiles={allowFiles}
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
  rows,
  emptyText,
  typing,
  showAuthors,
  loading,
  highlighted,
  onResend,
  onDiscard,
  onAnswered,
  onScreen,
  onOpenRoutine,
}: {
  rows: Row[]
  emptyText: string
  typing: BotInfo | undefined
  showAuthors: boolean
  loading: boolean
  /** The message the palette opened, highlighted a moment. */
  highlighted: string | undefined
  onResend: (entry: Outgoing) => void
  onDiscard: (entry: Outgoing) => void
  /** A card was answered, dismissed, handed back or decided: the server's message as it is now. */
  onAnswered: (message: MessageInfo) => void
  onScreen?: () => void
  onOpenRoutine?: (routineId: string) => void
}) {
  // Letter keys answer the newest open question only, skipping dismissed ones.
  const newestOpenQuestion = [...rows]
    .reverse()
    .find((row) => row.message?.card?.type === 'question' && !row.message.card.answer && !row.message.card.dismissed)?.key
  function rowElement(row: Row, index: number) {
    // Consecutive messages of one author sit close together, with tighter corners on the sender's side.
    const continuesPrevious = rows[index - 1]?.author === row.author
    const continuesNext = rows[index + 1]?.author === row.author
    const failed = row.outgoing?.error
    const card = row.message?.card
    if (card?.type === 'take_over') {
      return (
        <CardRow key={row.key} row={row} continuesNext={continuesNext}>
          <TakeOverCard
            message={row.message!}
            card={card}
            botName={row.authorName}
            onTakeOver={() => onScreen?.()}
            onOpenScreen={() => onScreen?.()}
            onHandedBack={onAnswered}
          />
        </CardRow>
      )
    }
    if (card?.type === 'plugin_request') {
      return (
        <CardRow key={row.key} row={row} continuesNext={continuesNext}>
          <PluginRequestCard message={row.message!} card={card} botName={row.authorName} onDecided={onAnswered} />
        </CardRow>
      )
    }
    if (card?.type === 'plugin_reconnect') {
      return (
        <CardRow key={row.key} row={row} continuesNext={continuesNext}>
          <PluginReconnectCard card={card} botName={row.authorName} />
        </CardRow>
      )
    }
    if (card?.type === 'routine_change') {
      return (
        <TimelineRow
          key={row.key}
          message={row.message!}
          card={card}
          enter={row.enter}
          onOpenRoutine={onOpenRoutine}
        />
      )
    }
    if (card?.type === 'question') {
      return (
        <CardRow key={row.key} row={row} continuesNext={continuesNext}>
          <QuestionCard message={row.message!} card={card} letterKeys={row.key === newestOpenQuestion} onAnswered={onAnswered} />
        </CardRow>
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
          {showAuthors && !row.mine && !continuesPrevious && <span className="px-3 text-xs text-muted-foreground">{row.authorName}</span>}
          {row.message?.botMessage && <BotMessageLabel botMessage={row.message.botMessage} />}
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
  }

  return (
    <div className="px-[max(30px,calc((100%-690px)/2))] pt-2 pb-7">
      {loading && <p className="text-center text-muted-foreground">Loading…</p>}
      {!loading && rows.length === 0 && <p className="text-center text-muted-foreground">{emptyText}</p>}
      {rows.map((row, index) => (
        <div
          key={row.key}
          data-message-id={row.message?.id}
          className={cn('-mx-2 rounded-2xl px-2 transition-colors duration-700', row.message && row.message.id === highlighted && 'bg-blue-subtle duration-150')}
        >
          {rowElement(row, index)}
        </div>
      ))}
      {typing && (
        <div
          aria-label={`${typing.name} is working`}
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

/** A card in a chat (a question, a take-over, a plugin request), as wide as cards are, read out as its author's. */
function CardRow({ row, continuesNext, children }: { row: Row; continuesNext: boolean; children: ReactNode }) {
  return (
    <div
      role="article"
      className={cn(
        'max-w-[min(88%,520px)] origin-bottom-left',
        continuesNext ? 'mb-1' : 'mb-[22px]',
        row.enter && 'motion-safe:animate-message-in motion-reduce:animate-fade-in',
      )}
    >
      <span className="sr-only">{row.authorName}: </span>
      {children}
    </div>
  )
}

const changeVerbs: Record<RoutineChangeCardInfo['change'], string> = {
  created: 'created',
  updated: 'changed',
  paused: 'paused',
  resumed: 'resumed',
  deleted: 'deleted',
}

/**
 * Grok's timeline event: a thin row noting a bot's change to one of its routines ("Rex created routine"), with a clock
 * chip naming the routine that opens it, and the time at the right.
 */
function TimelineRow({
  message,
  card,
  enter,
  onOpenRoutine,
}: {
  message: MessageInfo
  card: RoutineChangeCardInfo
  enter?: boolean
  onOpenRoutine?: (routineId: string) => void
}) {
  const chip = (
    <>
      <ClockIcon />
      <span className="truncate">{card.name}</span>
    </>
  )
  const chipClass = 'inline-flex max-w-[240px] min-w-0 items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-foreground'
  return (
    <div
      role="article"
      className={cn(
        'mb-[22px] flex min-h-8 items-center gap-1.5 text-sm text-muted-foreground',
        enter && 'animate-fade-in',
      )}
    >
      <span className="shrink-0">
        {message.authorName} {changeVerbs[card.change]} routine
      </span>
      {onOpenRoutine && card.change !== 'deleted' ? (
        <button type="button" onClick={() => onOpenRoutine(card.routineId)} className={cn('pressable hover:bg-secondary-hover', chipClass)}>
          {chip}
        </button>
      ) : (
        <span className={chipClass}>{chip}</span>
      )}
      <time dateTime={new Date(message.createdAt).toISOString()} className="ml-auto shrink-0 text-xs tabular-nums">
        {new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
      </time>
    </div>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden className="shrink-0 text-muted-foreground">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  )
}

/** Above a message between bots: Grok's "→ to Rex" on the sender's side, "← from Ana" on the recipient's. */
function BotMessageLabel({ botMessage }: { botMessage: BotMessageInfo }) {
  return (
    <span className="px-3 text-xs text-muted-foreground">
      {botMessage.direction === 'to' ? `→ to ${botMessage.name}` : `← from ${botMessage.name}`}
    </span>
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

/** The width of a button beside the composer's field, with the gap before it. */
const composerButtonWidth = 30 + 8

let measuring: CanvasRenderingContext2D | null | undefined

/** How wide `text` is in `field`'s font, on one line. */
function textWidth(field: HTMLTextAreaElement, text: string): number {
  measuring ??= document.createElement('canvas').getContext('2d')
  if (!measuring) return 0
  measuring.font = getComputedStyle(field).font
  return measuring.measureText(text).width
}

/**
 * Whether `text` takes more than one line in the composer's field when + and Send sit beside it: then the field spans the
 * composer and the buttons move to a row below. Measured against that one-line width, so the field widening doesn't
 * fold it back.
 */
function useMultiline(form: React.RefObject<HTMLFormElement | null>, field: React.RefObject<HTMLTextAreaElement | null>, text: string, buttons: number) {
  const [multiline, setMultiline] = useState(false)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!form.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(form.current)
    return () => observer.disconnect()
  }, [form])
  useLayoutEffect(() => {
    if (!field.current || !width) return
    // The field's own side padding (px-1) is part of the one-line width too.
    const oneLine = width - buttons * composerButtonWidth - 8
    setMultiline(text.includes('\n') || textWidth(field.current, text) > oneLine)
  }, [field, text, width, buttons])
  return multiline
}

/** How long the composer takes to move between one line and several. */
const composerReflowMs = 200

/**
 * Moves the composer between one line and several instead of letting it jump: the box eases to its new height and the
 * field, + and Send glide from where they were (FLIP: measured before and after, then played back with transforms).
 * Only that switch moves, not each new line, and nothing does with reduced motion.
 */
function useComposerReflow(multiline: boolean, form: React.RefObject<HTMLFormElement | null>, parts: React.RefObject<HTMLElement | null>[]) {
  const before = useRef<{ height: number; rects: (DOMRect | undefined)[] }>(undefined)
  const shown = useRef(multiline)

  useLayoutEffect(() => {
    const box = form.current
    const last = before.current
    const switched = shown.current !== multiline
    shown.current = multiline
    if (!box || !last || !switched || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const elements = [box, ...parts.map((part) => part.current)]
    // Interrupted mid-way: start again from where things are now, not from where they were headed.
    for (const element of elements) for (const running of element?.getAnimations() ?? []) running.cancel()
    const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-in-out-strong').trim() || 'ease-in-out'
    const timing = { duration: composerReflowMs, easing }
    const height = box.getBoundingClientRect().height
    // Height has no transform equivalent here: scaling the box would stretch its corners and text.
    if (height !== last.height) box.animate({ height: [`${last.height}px`, `${height}px`], overflow: ['clip', 'clip'] }, timing)
    parts.forEach((part, index) => {
      const element = part.current
      const from = last.rects[index]
      if (!element || !from) return
      const to = element.getBoundingClientRect()
      const [x, y] = [from.left - to.left, from.top - to.top]
      if (x || y) element.animate({ transform: [`translate(${x}px, ${y}px)`, 'translate(0, 0)'] }, timing)
    })
  }, [multiline, form, parts])

  // Where everything is after each render, for the next switch to start from.
  useLayoutEffect(() => {
    if (!form.current) return
    before.current = { height: form.current.getBoundingClientRect().height, rects: parts.map((part) => part.current?.getBoundingClientRect()) }
  })
}

/**
 * Writes to the chat. In a DM, a message sent while the bot works supersedes its run: there is no Stop, as in Grok.
 * Files come from the + button, a paste, or a drop anywhere on the chat. The chat's unsent text is kept by the live
 * store, so switching chats doesn't lose it. One line at first, with + and Send at its ends; once the text takes more
 * than a line, the field spans the composer and grows, with + and Send on their own row below.
 */
function Composer({
  chatId,
  label,
  allowFiles,
  files,
  notice,
  onAttach,
  onRemove,
  onSend,
}: {
  chatId: string
  label: string
  allowFiles: boolean
  files: File[]
  notice: string | undefined
  onAttach: (files: File[]) => void
  onRemove: (file: File) => void
  onSend: (text: string) => void
}) {
  const live = useLive()
  const text = live.drafts.get(chatId) ?? ''
  const picker = useRef<HTMLInputElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const multiline = useMultiline(form, field, text, allowFiles ? 2 : 1)
  const attach = useRef<HTMLButtonElement>(null)
  const submit = useRef<HTMLButtonElement>(null)
  const [parts] = useState(() => [field, attach, submit])
  useComposerReflow(multiline, form, parts)

  function send() {
    const draft = text.trim()
    if (!draft && !files.length) return
    live.setDraft(chatId, '')
    onSend(draft)
  }

  return (
    <div className="px-[max(24px,calc((100%-700px)/2))] pt-2 pb-[18px]">
      {notice && <p className="pb-1 text-[10px] text-muted-foreground">{notice}</p>}
      <form
        ref={form}
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
        <div
          className={cn(
            'grid items-center gap-x-2',
            multiline && 'gap-y-2',
            allowFiles
              ? multiline
                ? "grid-cols-[auto_1fr] [grid-template-areas:'field_field''attach_send']"
                : "grid-cols-[auto_1fr_auto] [grid-template-areas:'attach_field_send']"
              : multiline
                ? "grid-cols-[1fr] [grid-template-areas:'field''send']"
                : "grid-cols-[1fr_auto] [grid-template-areas:'field_send']",
          )}
        >
          {allowFiles && (
            <>
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
                ref={attach}
                type="button"
                aria-label="Attach files"
                title="Attach files"
                disabled={files.length >= maxAttachments}
                onClick={() => picker.current?.click()}
                className="pressable grid size-[30px] [grid-area:attach] shrink-0 place-items-center rounded-full bg-background text-foreground hover:bg-secondary-hover disabled:opacity-40"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </button>
            </>
          )}
          <textarea
            ref={field}
            data-composer
            aria-label={label}
            placeholder={label}
            rows={1}
            value={text}
            onChange={(event) => live.setDraft(chatId, event.target.value)}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files]
              if (!pasted.length || !allowFiles) return
              event.preventDefault()
              onAttach(pasted)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              }
            }}
            className="max-h-60 resize-none bg-transparent px-1 leading-[1.4] outline-none [field-sizing:content] [grid-area:field]"
          />
          <button
            ref={submit}
            type="submit"
            aria-label="Send"
            disabled={!text.trim() && !files.length}
            className={cn(roundButton, '[grid-area:send]', multiline && 'justify-self-end')}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  )
}
