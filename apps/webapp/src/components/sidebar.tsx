import type { BotInfo, ChatInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { useLive } from '../lib/live.tsx'
import { BotAvatar } from './bot-avatar.tsx'
import { NewBotDialog } from './new-bot-dialog.tsx'
import { ConfirmDelete } from './profile-pane.tsx'

/** Grok Bot's sidebar bounds, in px. */
const sidebarWidth = { initial: 280, min: 240, max: 400 }
const widthKey = 'openbot.sidebar.width'

const clampWidth = (width: number) => Math.round(Math.min(sidebarWidth.max, Math.max(sidebarWidth.min, width)))

/** The width the owner last dragged the sidebar to, kept in this browser. */
function useSidebarWidth() {
  // The shell only renders in the browser (it waits for onboarding status), so storage can be read up front.
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(widthKey))
      return saved ? clampWidth(saved) : sidebarWidth.initial
    } catch {
      return sidebarWidth.initial
    }
  })
  const commit = (next: number) => {
    const clamped = clampWidth(next)
    setWidth(clamped)
    try {
      localStorage.setItem(widthKey, String(clamped))
    } catch {
      // Storage blocked: the width lasts until reload.
    }
  }
  return [width, commit] as const
}

/** A bot's DM as one sidebar row. */
type Row = { bot: BotInfo; chat: ChatInfo | undefined; pinned: boolean }

/** Pinned chats first in the owner's order, then the rest oldest first. */
function sidebarRows(bots: readonly BotInfo[], chats: ReadonlyMap<string, ChatInfo>, pinnedIds: readonly string[]): Row[] {
  const rows = bots.map((bot) => ({ bot, chat: chats.get(bot.chatId), pinned: pinnedIds.includes(bot.chatId) }))
  const pinned = pinnedIds.flatMap((id) => rows.filter((row) => row.bot.chatId === id))
  return [...pinned, ...rows.filter((row) => !row.pinned)]
}

/** Grok's roster: live status dots, Draft / Waiting lines, pinning with drag to reorder, rename and delete. */
export function Sidebar() {
  const live = useLive()
  const navigate = useNavigate()
  const activeChatId = useActiveChatId()
  const [creating, setCreating] = useState(false)
  const [width, setWidth] = useSidebarWidth()
  const [preview, setPreview] = useState<number>()
  const [menu, setMenu] = useState<{ botId: string; x: number; y: number }>()
  const [renaming, setRenaming] = useState<string>()
  const [deleting, setDeleting] = useState<BotInfo>()
  const [error, setError] = useState<string>()
  const [dragging, setDragging] = useState<string>()
  const [dropTarget, setDropTarget] = useState<{ chatId: string; after: boolean }>()
  const now = useNow()
  const visible = useTabVisible()

  const pinnedIds = live.pinnedChatIds
  const rows = live.bots ? sidebarRows(live.bots, live.chats, pinnedIds) : []

  function pin(chatIds: string[]) {
    setError(undefined)
    live.setPinned(chatIds).catch((caught) => setError(errorMessage(caught)))
  }

  /** Moves the dragged pinned chat before or after `target`. */
  function drop(target: string, after: boolean) {
    const moved = dragging
    setDragging(undefined)
    setDropTarget(undefined)
    if (!moved || moved === target) return
    const order = pinnedIds.filter((id) => id !== moved)
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, moved)
    if (order.join() !== pinnedIds.join()) pin(order)
  }

  const openMenu = useCallback((row: Row, x: number, y: number) => setMenu({ botId: row.bot.id, x, y }), [])
  const closeMenu = useCallback(() => setMenu(undefined), [])
  // Read from the rows each render, so the menu follows live changes while open.
  const menuRow = menu && rows.find((row) => row.bot.id === menu.botId)

  return (
    <nav
      aria-label="Chats"
      style={{ width: preview ?? width }}
      className="relative flex shrink-0 flex-col border-r border-border-subtle bg-sidebar"
    >
      <header className="flex h-[50px] shrink-0 items-center justify-between border-b border-border-subtle pr-3 pl-4">
        <span className="font-semibold">OpenBot</span>
        <button type="button" onClick={() => setCreating(true)} className="pressable rounded-md px-2 py-1 hover:bg-secondary-hover">
          + New bot
        </button>
      </header>

      <ul className="flex flex-1 flex-col gap-[3px] overflow-y-auto px-3 pt-1 pb-6">
        {rows.map((row, index) => {
          const { bot, chat, pinned } = row
          const active = bot.chatId === activeChatId
          const lastPinned = pinned && !rows[index + 1]?.pinned
          const target = dropTarget?.chatId === bot.chatId ? dropTarget : undefined
          return (
            <li
              key={bot.id}
              className={cn('relative', lastPinned && 'mb-2 after:absolute after:inset-x-2 after:-bottom-[5px] after:h-px after:bg-border-subtle')}
              onDragOver={(event) => {
                if (!dragging) return
                if (!pinned || dragging === bot.chatId) return setDropTarget(undefined)
                event.preventDefault()
                const box = event.currentTarget.getBoundingClientRect()
                const after = event.clientY > box.top + box.height / 2
                if (target?.after !== after) setDropTarget({ chatId: bot.chatId, after })
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (pinned && target) drop(bot.chatId, target.after)
              }}
            >
              {target && (
                <span
                  aria-hidden
                  className={cn('absolute inset-x-2 h-0.5 rounded-full bg-status-unread', target.after ? '-bottom-[2.5px]' : '-top-[2.5px]')}
                />
              )}
              <ChatRow
                row={row}
                active={active}
                visible={visible}
                now={now}
                draft={live.drafts.get(bot.chatId)}
                renaming={renaming === bot.id}
                dragging={dragging === bot.chatId}
                onRenamed={() => setRenaming(undefined)}
                onStartRename={() => setRenaming(bot.id)}
                onMenu={openMenu}
                onDragStart={pinned ? () => setDragging(bot.chatId) : undefined}
                onDragEnd={() => {
                  setDragging(undefined)
                  setDropTarget(undefined)
                }}
              />
            </li>
          )
        })}
      </ul>

      {error && (
        <p role="alert" className="px-4 pb-2 text-sm text-destructive-foreground">
          {error}
        </p>
      )}

      <footer className="px-3 pb-3">
        <Link
          to="/settings/providers"
          className="block rounded-md px-2 py-1.5 text-muted-foreground transition-colors duration-100 hover:bg-secondary active:bg-selected"
        >
          Settings
        </Link>
      </footer>

      <ResizeHandle width={width} onPreview={setPreview} onCommit={setWidth} />

      {menu && menuRow && (
        <RowMenu
          row={menuRow}
          x={menu.x}
          y={menu.y}
          pinnedIds={pinnedIds}
          onClose={closeMenu}
          onPin={pin}
          onMarkRead={(chatId) => void live.markRead(chatId, undefined).catch((caught) => setError(errorMessage(caught)))}
          onRename={(bot) => setRenaming(bot.id)}
          onDelete={setDeleting}
        />
      )}

      {deleting && (
        <ConfirmDelete
          bot={deleting}
          onCancel={() => setDeleting(undefined)}
          onDeleted={() => {
            live.removeBot(deleting.id, deleting.chatId)
            if (deleting.chatId === activeChatId) navigate({ to: '/', replace: true })
            setDeleting(undefined)
          }}
        />
      )}

      {creating && <NewBotDialog onClose={() => setCreating(false)} />}
    </nav>
  )
}

/** The chat the owner has open, if any. */
function useActiveChatId(): string | undefined {
  const live = useLive()
  const botId = useRouterState({
    select: (state) => state.matches.find((match) => match.routeId === '/_app/bots/$botId')?.params as { botId?: string } | undefined,
  })?.botId
  return live.bots?.find((bot) => bot.id === botId)?.chatId
}

/** Whether this tab is in view. */
function useTabVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

/** The current time, ticking each minute so relative times stay right. */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Grok's compact relative time: now, 5m, 3h, 2d. */
function relativeTime(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** One line of plain text from markdown, for previews. */
function previewText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The row's second line, in Grok's priority: the owner's draft, what the bot waits for, its activity, the latest message. */
function secondLine(bot: BotInfo, chat: ChatInfo | undefined, draft: string | undefined) {
  if (draft?.trim()) return { label: 'Draft: ', text: previewText(draft), className: 'text-muted-foreground', labelClass: 'text-red-foreground' }
  if (chat?.waitingFor) {
    return { label: 'Waiting for you: ', text: previewText(chat.waitingFor), className: 'text-muted-foreground', labelClass: 'text-amber-foreground' }
  }
  if (bot.working) return { text: 'Working…', className: 'text-green-foreground' }
  if (bot.error) return { text: "Couldn't reach its model", className: 'text-red-foreground' }
  const last = chat?.lastMessage
  if (last) return { text: (last.author === 'owner' ? 'You: ' : '') + previewText(last.text), className: 'text-muted-foreground' }
  return { text: bot.title ?? 'No messages yet', className: 'text-muted-foreground' }
}

function ChatRow({
  row,
  active,
  visible,
  now,
  draft,
  renaming,
  dragging,
  onRenamed,
  onStartRename,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  row: Row
  active: boolean
  /** The tab is in view, so the open chat is really being read. */
  visible: boolean
  now: number
  draft: string | undefined
  renaming: boolean
  dragging: boolean
  onRenamed: () => void
  onStartRename: () => void
  onMenu: (row: Row, x: number, y: number) => void
  onDragStart: (() => void) | undefined
  onDragEnd: () => void
}) {
  const { bot, chat, pinned } = row
  const line = secondLine(bot, chat, draft)
  // The open chat in a visible tab is being read, so it doesn't show as unread.
  const needsYou = !!chat?.waitingFor
  const unread = !!chat?.unread && !(active && visible)
  const status = needsYou ? 'Needs attention' : unread ? 'Unread activity' : undefined

  if (renaming) return <RenameRow bot={bot} onDone={onRenamed} />

  return (
    <Link
      to="/bots/$botId"
      params={{ botId: bot.id }}
      draggable={!!onDragStart}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        // Its own type, so dropping the row on the composer types nothing.
        event.dataTransfer.setData('application/x-openbot-chat', bot.chatId)
        onDragStart?.()
      }}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(row, event.clientX, event.clientY)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          const box = event.currentTarget.getBoundingClientRect()
          onMenu(row, box.left + 24, box.bottom - 8)
        } else if (event.key === 'F2') {
          event.preventDefault()
          onStartRename()
        }
      }}
      className={cn(
        'grid min-h-[58px] grid-cols-[34px_1fr_auto] items-center gap-[9px] rounded-[10px] p-2 transition-[background-color,opacity] duration-100 hover:bg-secondary active:bg-selected',
        dragging && 'opacity-50',
      )}
      activeProps={{ className: 'bg-secondary', 'aria-current': 'page' }}
    >
      {/* Grok's working state: running and not waiting for the owner. */}
      <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} working={bot.working && !needsYou} />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1">
          <span
            className={cn('truncate', unread && 'font-semibold')}
            onDoubleClick={(event) => {
              event.preventDefault()
              onStartRename()
            }}
          >
            {bot.name}
          </span>
          {pinned && <PinIcon />}
        </span>
        <span className={cn('truncate text-xs', line.className)}>
          {line.label && <span className={line.labelClass}>{line.label}</span>}
          {line.text}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1 self-start pt-0.5">
        {chat?.lastMessage && <span className="text-xs text-muted-foreground tabular-nums">{relativeTime(chat.lastMessage.createdAt, now)}</span>}
        {status && (
          <span
            title={status}
            className={cn(
              'size-2 rounded-full motion-safe:animate-pop-in motion-reduce:animate-fade-in',
              needsYou ? 'bg-status-attention' : 'bg-status-unread',
            )}
          >
            <span className="sr-only">{status}</span>
          </span>
        )}
      </span>
    </Link>
  )
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-label="Pinned" role="img" className="shrink-0 text-muted-foreground" fill="currentColor">
      <path d="M10.5 1.5 14.5 5.5 12.6 6.2 10.2 8.6 10.6 12 9.5 13.1 6.7 10.3 3 14 2 13 5.7 9.3 2.9 6.5 4 5.4 7.4 5.8 9.8 3.4Z" />
    </svg>
  )
}

/** Renames a bot in place: Enter or leaving the field saves, Esc cancels. */
function RenameRow({ bot, onDone }: { bot: BotInfo; onDone: () => void }) {
  const live = useLive()
  const [name, setName] = useState(bot.name)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const settled = useRef(false)

  async function save() {
    const trimmed = name.trim()
    if (settled.current || saving) return
    if (!trimmed || trimmed === bot.name) {
      settled.current = true
      return onDone()
    }
    setSaving(true)
    setError(undefined)
    try {
      live.updateBot(await api().bots.update({ botId: bot.id, name: trimmed }))
      settled.current = true
      onDone()
    } catch (caught) {
      setError(errorMessage(caught))
      setSaving(false)
    }
  }

  return (
    <div className="grid min-h-[58px] grid-cols-[34px_1fr] items-center gap-[9px] rounded-[10px] bg-secondary p-2">
      <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} working={bot.working} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <input
          aria-label={`Rename ${bot.name}`}
          autoFocus
          value={name}
          maxLength={80}
          disabled={saving}
          aria-invalid={!!error}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              settled.current = true
              onDone()
            }
          }}
          className="min-w-0 rounded-[4px] border border-border bg-background px-1.5 py-0.5 outline-none focus:border-border-strong aria-invalid:border-destructive"
        />
        {error && (
          <span role="alert" className="truncate text-xs text-destructive-foreground" title={error}>
            {error}
          </span>
        )}
      </span>
    </div>
  )
}

/** A row's context menu, after Grok's: Pin / Unpin, reorder pinned chats, Mark as read, Rename, Delete. */
function RowMenu({
  row: { bot, chat, pinned },
  x,
  y,
  pinnedIds,
  onClose,
  onPin,
  onMarkRead,
  onRename,
  onDelete,
}: {
  row: Row
  x: number
  y: number
  pinnedIds: string[]
  onClose: () => void
  onPin: (chatIds: string[]) => void
  onMarkRead: (chatId: string) => void
  onRename: (bot: BotInfo) => void
  onDelete: (bot: BotInfo) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const restoreFocus = useRef<Element | null>(null)
  const place = pinnedIds.indexOf(bot.chatId)

  const move = (offset: number) => {
    const order = [...pinnedIds]
    order.splice(place, 1)
    order.splice(place + offset, 0, bot.chatId)
    onPin(order)
  }

  const items: { label: string; danger?: boolean; run: () => void }[] = [
    pinned
      ? { label: 'Unpin', run: () => onPin(pinnedIds.filter((id) => id !== bot.chatId)) }
      : { label: 'Pin', run: () => onPin([...pinnedIds, bot.chatId]) },
    ...(pinned && place > 0 ? [{ label: 'Move up', run: () => move(-1) }] : []),
    ...(pinned && place < pinnedIds.length - 1 ? [{ label: 'Move down', run: () => move(1) }] : []),
    ...(chat?.unread ? [{ label: 'Mark as Read', run: () => onMarkRead(bot.chatId) }] : []),
    { label: 'Rename', run: () => onRename(bot) },
    { label: 'Delete', danger: true, run: () => onDelete(bot) },
  ]

  // Kept inside the window, and focused so the keyboard works at once.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    restoreFocus.current = document.activeElement
    const box = menu.getBoundingClientRect()
    setPosition({ left: Math.min(x, innerWidth - box.width - 8), top: Math.min(y, innerHeight - box.height - 8) })
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [x, y])

  useEffect(() => {
    const close = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    addEventListener('pointerdown', close, true)
    addEventListener('blur', onClose)
    addEventListener('resize', onClose)
    return () => {
      removeEventListener('pointerdown', close, true)
      removeEventListener('blur', onClose)
      removeEventListener('resize', onClose)
    }
  }, [onClose])

  function dismiss() {
    onClose()
    if (restoreFocus.current instanceof HTMLElement) restoreFocus.current.focus()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${bot.name}`}
      style={position}
      onKeyDown={(event) => {
        const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const index = buttons.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          dismiss()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          buttons[(index + step + buttons.length) % buttons.length]?.focus()
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus()
        }
      }}
      className="fixed z-40 flex min-w-[180px] flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg motion-safe:animate-pop-in motion-reduce:animate-fade-in"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            onClose()
            item.run()
          }}
          className={cn(
            'rounded-md px-2.5 py-1.5 text-left text-base outline-none hover:bg-secondary focus-visible:bg-secondary',
            item.danger && 'text-destructive-foreground',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Grok's 12px handle on the sidebar's right edge: dragging previews the width live and keeps it on release; Esc
 * cancels the drag. Arrow keys resize it too.
 */
function ResizeHandle({
  width,
  onPreview,
  onCommit,
}: {
  width: number
  onPreview: (width: number | undefined) => void
  onCommit: (width: number) => void
}) {
  const drag = useRef<{ startX: number; startWidth: number; current: number }>(undefined)

  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return
      drag.current = undefined
      onPreview(undefined)
    }
    addEventListener('keydown', cancel)
    return () => removeEventListener('keydown', cancel)
  }, [onPreview])

  const end = (event: PointerEvent<HTMLDivElement>) => {
    const ended = drag.current
    drag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onPreview(undefined)
    if (ended) onCommit(ended.current)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={sidebarWidth.min}
      aria-valuemax={sidebarWidth.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { startX: event.clientX, startWidth: width, current: width }
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        drag.current.current = clampWidth(drag.current.startWidth + event.clientX - drag.current.startX)
        onPreview(drag.current.current)
      }}
      onPointerUp={end}
      onPointerCancel={() => {
        drag.current = undefined
        onPreview(undefined)
      }}
      onDoubleClick={() => onCommit(sidebarWidth.initial)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10
        if (event.key === 'ArrowLeft') onCommit(width - step)
        else if (event.key === 'ArrowRight') onCommit(width + step)
        else if (event.key === 'Home') onCommit(sidebarWidth.min)
        else if (event.key === 'End') onCommit(sidebarWidth.max)
        else return
        event.preventDefault()
      }}
      className="group absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none outline-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-100 group-hover:bg-border-strong group-focus-visible:bg-status-unread" />
    </div>
  )
}
