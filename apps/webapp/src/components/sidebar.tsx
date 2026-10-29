import { type BotInfo, maxSectionNameLength, type SectionInfo, unassignedSectionId } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { runCommand, useCommand } from '../lib/commands.ts'
import { useLive } from '../lib/live.tsx'
import { membersOf } from '../lib/groups.ts'
import { relativeTime } from '../lib/palette.ts'
import { hiddenFoldKey, rangeBetween, selectableChatIds, type SidebarBlock, type SidebarRow, sidebarLayout } from '../lib/sidebar.ts'
import { useNarrowWindow, useSidebarPrefs } from '../lib/sidebar-prefs.ts'
import { summarizeAttachments } from './attachments.tsx'
import { BotAvatar, GroupAvatar } from './bot-avatar.tsx'
import { NewBotDialog } from './new-bot-dialog.tsx'
import { ConfirmDeleteBot, ConfirmDeleteChats, ConfirmDeleteGroup, ConfirmDeleteSection } from './confirm-delete.tsx'

/** Grok Bot's sidebar bounds, in px, and its compact rail's width. */
const sidebarWidth = { initial: 280, min: 240, max: 400 }
const railWidth = 88
const widthKey = 'openbot.sidebar.width'

/** What a section made from "Move to new section" or "New section" is called until the owner renames it. */
const newSectionName = 'New section'

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

type Row = SidebarRow

/** A row's name: its bot's, or the group's. */
const rowName = (row: Row) => row.bot?.name ?? row.chat?.name ?? ''

/** A section's name as its header shows it. */
const sectionLabel = (section: SectionInfo) => section.name ?? 'Unassigned'

/** One entry of a context menu; one with `items` opens them in its place. */
type MenuItem = { label: string; danger?: boolean; run?: () => void; items?: MenuItem[] }

/** The chats being dragged: a pinned one reorders the pinned chats; others (a whole selection) move to a section. */
type Dragging = { chatIds: string[]; pinned: boolean }

/**
 * Grok's roster of DMs and group chats: live status dots, Draft / Waiting lines, pinning with drag to reorder, the
 * owner's sections with Unassigned and Hidden, multi-select with Move / Delete, rename and delete, and the ⌘B rail.
 */
export function Sidebar() {
  const live = useLive()
  const prefs = useSidebarPrefs()
  const narrow = useNarrowWindow()
  const compact = prefs.compact || narrow
  const navigate = useNavigate()
  const activeChatId = useActiveChatId()
  const [creating, setCreating] = useState(false)
  const [newMenu, setNewMenu] = useState(false)
  const [width, setWidth] = useSidebarWidth()
  const [preview, setPreview] = useState<number>()
  const [menu, setMenu] = useState<{ label: string; items: MenuItem[]; x: number; y: number }>()
  const [renaming, setRenaming] = useState<string>()
  const [renamingSection, setRenamingSection] = useState<string>()
  const [deleting, setDeleting] = useState<Row>()
  const [deletingSection, setDeletingSection] = useState<SectionInfo>()
  const [deletingSelection, setDeletingSelection] = useState<Row[]>()
  const [error, setError] = useState<string>()
  const [dragging, setDragging] = useState<Dragging>()
  const [dropTarget, setDropTarget] = useState<{ chatId: string; after: boolean }>()
  const [dropSection, setDropSection] = useState<string>()
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  /** Where a Shift-click range starts: the row clicked last. */
  const anchor = useRef<string>(undefined)
  const now = useNow()
  const visible = useTabVisible()

  const layout = sidebarLayout(live.bots ?? [], live.chats, live.sections, prefs.folds)
  const rows = layout.blocks.flatMap((block) => block.rows)
  const rowOf = (chatId: string) => rows.find((row) => row.chatId === chatId)
  // A chat deleted elsewhere leaves the selection.
  const selection = rows.filter((row) => picked.has(row.chatId))
  const pinnedIds = live.pinnedChatIds
  const ownSections = live.sections.filter((section) => section.id !== unassignedSectionId)

  const fail = (caught: unknown) => setError(errorMessage(caught))
  const attempt = (work: Promise<unknown>) => {
    setError(undefined)
    work.catch(fail)
  }

  function pin(chatIds: string[]) {
    attempt(live.setPinned(chatIds))
  }

  const clearSelection = useCallback(() => setPicked(new Set()), [])

  useEffect(() => {
    if (!picked.size) return
    const clear = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) clearSelection()
    }
    addEventListener('keydown', clear)
    return () => removeEventListener('keydown', clear)
  }, [picked.size, clearSelection])

  /** Grok's multi-select: ⌘/Ctrl-click toggles a row, Shift-click selects a range; a plain click opens the chat. */
  function clickRow(row: Row, event: MouseEvent) {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      const next = new Set(picked)
      if (next.has(row.chatId)) next.delete(row.chatId)
      else next.add(row.chatId)
      setPicked(next)
      anchor.current = row.chatId
    } else if (event.shiftKey) {
      event.preventDefault()
      setPicked(new Set(rangeBetween(selectableChatIds(layout), anchor.current ?? activeChatId ?? row.chatId, row.chatId)))
    } else {
      clearSelection()
      anchor.current = row.chatId
    }
  }

  /** Moves the dragged pinned chat before or after `target`. */
  function dropPinned(target: string, after: boolean) {
    const moved = dragging?.chatIds[0]
    endDrag()
    if (!moved || moved === target) return
    const order = pinnedIds.filter((id) => id !== moved)
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, moved)
    if (order.join() !== pinnedIds.join()) pin(order)
  }

  function endDrag() {
    setDragging(undefined)
    setDropTarget(undefined)
    setDropSection(undefined)
  }

  function startDrag(row: Row) {
    if (row.pinned) return setDragging({ chatIds: [row.chatId], pinned: true })
    // Dragging a selected row carries the whole selection, as in Grok.
    const chatIds = picked.has(row.chatId) ? selection.filter((entry) => !entry.pinned).map((entry) => entry.chatId) : [row.chatId]
    setDragging({ chatIds, pinned: false })
  }

  function moveTo(chatIds: string[], sectionId: string) {
    clearSelection()
    attempt(live.moveChats(chatIds, sectionId))
  }

  /** Adds a section at the top, moves `chatIds` there, and names it at once, as Grok's "Move to new section" does. */
  function newSection(chatIds: string[] = []) {
    clearSelection()
    setError(undefined)
    live
      .createSection(newSectionName)
      .then(async (section) => {
        if (prefs.compact) prefs.setCompact(false)
        if (chatIds.length) await live.moveChats(chatIds, section.id)
        setRenamingSection(section.id)
      })
      .catch(fail)
  }

  useCommand('new-bot', () => setCreating(true))
  useCommand('new-section', () => newSection())

  /** Where chats can move: every section but the one they're all in, then a new one. */
  function moveItems(chatIds: string[]): MenuItem[] {
    const current = new Set(chatIds.map((id) => rowOf(id)?.chat?.sectionId))
    const here = current.size === 1 && !chatIds.some((id) => rowOf(id)?.chat?.hidden) ? [...current][0] : undefined
    return [
      ...live.sections.filter((section) => section.id !== here).map((section) => ({ label: sectionLabel(section), run: () => moveTo(chatIds, section.id) })),
      { label: newSectionName, run: () => newSection(chatIds) },
    ]
  }

  /** A row's context menu, after Grok's: Pin, Move to, Mark as Read, Rename, Hide from sidebar, Delete. */
  function rowMenu(row: Row): MenuItem[] {
    const { bot, chat, pinned, chatId } = row
    const hidden = !!chat?.hidden
    const place = pinnedIds.indexOf(chatId)
    const movePinned = (offset: number) => {
      const order = [...pinnedIds]
      order.splice(place, 1)
      order.splice(place + offset, 0, chatId)
      pin(order)
    }
    return [
      ...(hidden ? [] : [pinned ? { label: 'Unpin', run: () => pin(pinnedIds.filter((id) => id !== chatId)) } : { label: 'Pin', run: () => pin([...pinnedIds, chatId]) }]),
      ...(pinned && place > 0 ? [{ label: 'Move up', run: () => movePinned(-1) }] : []),
      ...(pinned && place < pinnedIds.length - 1 ? [{ label: 'Move down', run: () => movePinned(1) }] : []),
      // Not offered on pinned rows, as in Grok: a pinned chat sits above every section.
      ...(pinned || hidden ? [] : ownSections.length ? [{ label: 'Move to', items: moveItems([chatId]) }] : [{ label: 'Move to new section', run: () => newSection([chatId]) }]),
      ...(chat?.unread ? [{ label: 'Mark as Read', run: () => attempt(live.markRead(chatId, undefined)) }] : []),
      { label: 'Rename', run: () => setRenaming(chatId) },
      hidden ? { label: 'Show in sidebar', run: () => attempt(live.showChats([chatId])) } : { label: 'Hide from sidebar', run: () => attempt(live.hideChats([chatId])) },
      ...(bot || chat ? [{ label: 'Delete', danger: true, run: () => setDeleting(row) }] : []),
    ]
  }

  /** A section header's context menu: Rename, Move up, Move down, Delete; Unassigned only moves. */
  function sectionMenu(section: SectionInfo): MenuItem[] {
    const order = live.sections.map((entry) => entry.id)
    const place = order.indexOf(section.id)
    const move = (offset: number) => {
      order.splice(place, 1)
      order.splice(place + offset, 0, section.id)
      attempt(live.reorderSections(order))
    }
    const own = section.id !== unassignedSectionId
    return [
      ...(own ? [{ label: 'Rename', run: () => setRenamingSection(section.id) }] : []),
      ...(place > 0 ? [{ label: 'Move up', run: () => move(-1) }] : []),
      ...(place < order.length - 1 ? [{ label: 'Move down', run: () => move(1) }] : []),
      ...(own ? [{ label: 'Delete', danger: true, run: () => setDeletingSection(section) }] : []),
    ]
  }

  const openMenu = (label: string, items: MenuItem[], x: number, y: number) => items.length && setMenu({ label, items, x, y })
  const openRowMenu = (row: Row, x: number, y: number) => openMenu(`Actions for ${rowName(row)}`, rowMenu(row), x, y)
  const closeMenu = useCallback(() => setMenu(undefined), [])

  function rowElement(row: Row, block: SidebarBlock, index: number) {
    const { chatId, pinned } = row
    const lastPinned = block.kind === 'pinned' && index === block.rows.length - 1
    const target = dropTarget?.chatId === chatId ? dropTarget : undefined
    return (
      <li
        key={chatId}
        className={cn('relative', lastPinned && 'mb-2 after:absolute after:inset-x-2 after:-bottom-[5px] after:h-px after:bg-border-subtle')}
        onDragOver={(event) => {
          if (!dragging?.pinned) return
          if (!pinned || dragging.chatIds[0] === chatId) return setDropTarget(undefined)
          event.preventDefault()
          const box = event.currentTarget.getBoundingClientRect()
          const after = event.clientY > box.top + box.height / 2
          if (target?.after !== after) setDropTarget({ chatId, after })
        }}
        onDrop={(event) => {
          if (!dragging?.pinned) return
          event.preventDefault()
          if (pinned && target) dropPinned(chatId, target.after)
        }}
      >
        {target && (
          <span aria-hidden className={cn('absolute inset-x-2 h-0.5 rounded-full bg-status-unread', target.after ? '-bottom-[2.5px]' : '-top-[2.5px]')} />
        )}
        <ChatRow
          row={row}
          active={chatId === activeChatId}
          selected={picked.has(chatId)}
          visible={visible}
          now={now}
          draft={live.drafts.get(chatId)}
          renaming={renaming === chatId}
          dragging={!!dragging?.chatIds.includes(chatId)}
          onClick={clickRow}
          onRenamed={() => setRenaming(undefined)}
          onStartRename={() => setRenaming(chatId)}
          onMenu={openRowMenu}
          onDragStart={() => startDrag(row)}
          onDragEnd={endDrag}
        />
      </li>
    )
  }

  /** A section's rows under its header; dragging chats onto it moves them there. */
  function sectionElement(block: Extract<SidebarBlock, { kind: 'section' }>) {
    const { section, rows: sectionRows, folded } = block
    const accepts = dragging && !dragging.pinned
    return (
      <li
        key={section.id}
        className={cn('rounded-[10px] transition-colors duration-100', dropSection === section.id && 'bg-blue-subtle outline outline-blue/40')}
        onDragOver={(event) => {
          if (!accepts) return
          event.preventDefault()
          if (dropSection !== section.id) setDropSection(section.id)
        }}
        onDrop={(event) => {
          if (!accepts) return
          event.preventDefault()
          const chatIds = dragging.chatIds.filter((id) => rowOf(id)?.chat?.sectionId !== section.id || rowOf(id)?.chat?.hidden)
          endDrag()
          if (chatIds.length) moveTo(chatIds, section.id)
        }}
      >
        {layout.headers &&
          (renamingSection === section.id ? (
            <SectionRename
              name={section.name ?? ''}
              onDone={(name) => {
                setRenamingSection(undefined)
                if (name && name !== section.name) attempt(live.renameSection(section.id, name))
              }}
            />
          ) : (
            <SectionHeader
              label={sectionLabel(section)}
              count={sectionRows.length}
              folded={folded}
              onToggle={() => prefs.setFolded(section.id, !folded)}
              onMenu={(x, y) => openMenu(`Actions for ${sectionLabel(section)}`, sectionMenu(section), x, y)}
              onRename={section.id === unassignedSectionId ? undefined : () => setRenamingSection(section.id)}
            />
          ))}
        {!folded &&
          (sectionRows.length ? (
            <ul className="flex flex-col gap-[3px]">{sectionRows.map((row, index) => rowElement(row, block, index))}</ul>
          ) : (
            <p className="px-2 pt-1 pb-3 text-xs text-muted-foreground">Drag chats here</p>
          ))}
      </li>
    )
  }

  return (
    <nav
      aria-label="Chats"
      style={{ width: compact ? railWidth : (preview ?? width) }}
      className="relative flex shrink-0 flex-col border-r border-border-subtle bg-sidebar transition-[width] duration-150 ease-out motion-reduce:transition-none"
    >
      {selection.length > 0 && !compact ? (
        <SelectionBar
          count={selection.length}
          // Pinned chats stay where they are, as their own Move to isn't offered.
          onMove={(x, y) => openMenu('Move to', moveItems(selection.filter((row) => !row.pinned).map((row) => row.chatId)), x, y)}
          canMove={selection.some((row) => !row.pinned)}
          onDelete={() => setDeletingSelection(selection)}
          onClear={clearSelection}
        />
      ) : (
        <header className={cn('flex h-[50px] shrink-0 items-center border-b border-border-subtle', compact ? 'justify-center' : 'justify-between pr-3 pl-4')}>
          {!compact && <span className="font-semibold">OpenBot</span>}
          <span className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={newMenu}
              aria-label={compact ? 'New' : undefined}
              onClick={() => setNewMenu((open) => !open)}
              className={cn('pressable hover:bg-secondary-hover', compact ? 'grid size-8 place-items-center rounded-full bg-secondary' : 'rounded-md px-2 py-1')}
            >
              {compact ? '+' : '+ New'}
            </button>
            {newMenu && (
              <NewMenu
                compact={compact}
                onClose={() => setNewMenu(false)}
                onNewBot={() => setCreating(true)}
                onNewGroup={() => navigate({ to: '/groups/new' })}
                onNewSection={() => newSection()}
              />
            )}
          </span>
        </header>
      )}

      <div className={cn('shrink-0 pt-2', compact ? 'flex justify-center' : 'px-3')}>
        <button
          type="button"
          onClick={() => runCommand('open-palette', 'all')}
          aria-label="Search"
          aria-keyshortcuts="Meta+K"
          className={cn(
            'pressable flex items-center gap-2 rounded-md text-muted-foreground ring-[0.5px] ring-border ring-inset hover:bg-secondary',
            compact ? 'size-8 justify-center' : 'h-7 w-full px-2 text-sm',
          )}
        >
          <SearchIcon />
          {!compact && (
            <>
              <span>Search</span>
              <kbd className="ml-auto font-sans text-xs">⌘K</kbd>
            </>
          )}
        </button>
      </div>

      {compact ? (
        <ul className="flex flex-1 flex-col items-center gap-[3px] overflow-y-auto px-2 pt-2 pb-6">
          {/* The rail flattens sections and leaves Hidden out, as Grok's does. */}
          {layout.blocks.flatMap((block) =>
            block.kind === 'hidden'
              ? []
              : block.rows.map((row) => (
                  <li key={row.chatId}>
                    <RailRow row={row} active={row.chatId === activeChatId} visible={visible} onMenu={openRowMenu} />
                  </li>
                )),
          )}
        </ul>
      ) : (
        <ul className="flex flex-1 flex-col gap-[3px] overflow-y-auto px-3 pt-1 pb-6">
          {layout.blocks.map((block) => {
            if (block.kind === 'pinned') return block.rows.map((row, index) => rowElement(row, block, index))
            if (block.kind === 'section') return sectionElement(block)
            return (
              <li key={hiddenFoldKey} id="sidebar-hidden">
                <SectionHeader label="Hidden" count={block.rows.length} folded={block.folded} onToggle={() => prefs.setFolded(hiddenFoldKey, !block.folded)} />
                {!block.folded && <ul className="flex flex-col gap-[3px]">{block.rows.map((row, index) => rowElement(row, block, index))}</ul>}
              </li>
            )
          })}
        </ul>
      )}

      {error && (
        <p role="alert" className={cn('pb-2 text-sm text-destructive-foreground', compact ? 'px-2' : 'px-4')}>
          {error}
        </p>
      )}

      <footer className={cn('pb-3', compact ? 'px-2' : 'px-3')}>
        <Link
          to="/settings/providers"
          aria-label={compact ? 'Settings' : undefined}
          className="block truncate rounded-md px-2 py-1.5 text-muted-foreground transition-colors duration-100 hover:bg-secondary active:bg-selected"
        >
          {compact ? '⚙' : 'Settings'}
        </Link>
      </footer>

      {!compact && <ResizeHandle width={width} onPreview={setPreview} onCommit={setWidth} />}

      {menu && <Menu label={menu.label} items={menu.items} x={menu.x} y={menu.y} onClose={closeMenu} />}

      {deleting?.bot && (
        <ConfirmDeleteBot
          bot={deleting.bot}
          onCancel={() => setDeleting(undefined)}
          onDeleted={() => {
            live.removeBot(deleting.bot!.id, deleting.chatId)
            if (deleting.chatId === activeChatId) navigate({ to: '/', replace: true })
            setDeleting(undefined)
          }}
        />
      )}
      {deleting?.chat && !deleting.bot && (
        <ConfirmDeleteGroup
          chat={deleting.chat}
          onCancel={() => setDeleting(undefined)}
          onDeleted={() => {
            live.removeChat(deleting.chatId)
            if (deleting.chatId === activeChatId) navigate({ to: '/', replace: true })
            setDeleting(undefined)
          }}
        />
      )}
      {deletingSelection && (
        <ConfirmDeleteChats
          chats={deletingSelection}
          onCancel={() => setDeletingSelection(undefined)}
          onDeleted={() => {
            for (const row of deletingSelection) {
              if (row.bot) live.removeBot(row.bot.id, row.chatId)
              else live.removeChat(row.chatId)
            }
            if (deletingSelection.some((row) => row.chatId === activeChatId)) navigate({ to: '/', replace: true })
            setDeletingSelection(undefined)
            clearSelection()
          }}
        />
      )}
      {deletingSection && (
        <ConfirmDeleteSection
          name={sectionLabel(deletingSection)}
          remove={() => live.deleteSection(deletingSection.id)}
          onCancel={() => setDeletingSection(undefined)}
          onDeleted={() => setDeletingSection(undefined)}
        />
      )}

      {creating && <NewBotDialog onClose={() => setCreating(false)} />}
    </nav>
  )
}

/** Grok's header while chats are selected: Move ▾, Delete and Clear in place of New. */
function SelectionBar({
  count,
  canMove,
  onMove,
  onDelete,
  onClear,
}: {
  count: number
  /** Some selected chat isn't pinned. */
  canMove: boolean
  onMove: (x: number, y: number) => void
  onDelete: () => void
  onClear: () => void
}) {
  return (
    <header className="flex h-[50px] shrink-0 items-center gap-1 border-b border-border-subtle pr-3 pl-4 motion-safe:animate-fade-in">
      <span className="mr-auto text-sm text-muted-foreground tabular-nums">{count} selected</span>
      <button
        type="button"
        aria-haspopup="menu"
        disabled={!canMove}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          onMove(box.left, box.bottom + 4)
        }}
        className="pressable rounded-md px-2 py-1 hover:bg-secondary-hover disabled:opacity-40"
      >
        Move ▾
      </button>
      <button type="button" onClick={onDelete} className="pressable rounded-md px-2 py-1 text-destructive-foreground hover:bg-secondary-hover">
        Delete
      </button>
      <button type="button" onClick={onClear} className="pressable rounded-md px-2 py-1 hover:bg-secondary-hover">
        Clear
      </button>
    </header>
  )
}

/** Grok's 30px section header: clicking folds it, a folded one shows its count, its menu holds its actions. */
function SectionHeader({
  label,
  count,
  folded,
  onToggle,
  onMenu,
  onRename,
}: {
  label: string
  count: number
  folded: boolean
  onToggle: () => void
  onMenu?: (x: number, y: number) => void
  onRename?: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={!folded}
      onClick={onToggle}
      onDoubleClick={(event) => {
        if (!onRename) return
        event.preventDefault()
        onRename()
      }}
      onContextMenu={(event) => {
        if (!onMenu) return
        event.preventDefault()
        onMenu(event.clientX, event.clientY)
      }}
      onKeyDown={(event) => {
        if (onMenu && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
          event.preventDefault()
          const box = event.currentTarget.getBoundingClientRect()
          onMenu(box.left + 24, box.bottom - 4)
        } else if (onRename && event.key === 'F2') {
          event.preventDefault()
          onRename()
        }
      }}
      className="group flex h-[30px] w-full items-center gap-1 rounded-md px-2 pt-2 pb-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-secondary focus-visible:bg-secondary"
    >
      <span className="truncate">{label}</span>
      {folded && <span className="tabular-nums">{count}</span>}
      <svg
        viewBox="0 0 16 16"
        width="10"
        height="10"
        aria-hidden
        className={cn(
          'ml-auto shrink-0 opacity-0 transition-[opacity,rotate] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
          folded ? '-rotate-90' : 'rotate-0',
        )}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </button>
  )
}

/** Names a section in place: Enter or leaving the field saves, Esc keeps the name it had. */
function SectionRename({ name, onDone }: { name: string; onDone: (name: string | undefined) => void }) {
  const [value, setValue] = useState(name)
  const settled = useRef(false)
  const finish = (result: string | undefined) => {
    if (settled.current) return
    settled.current = true
    onDone(result)
  }
  return (
    <input
      aria-label={`Rename ${name}`}
      autoFocus
      value={value}
      maxLength={maxSectionNameLength}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value.trim() || undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(value.trim() || undefined)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(undefined)
        }
      }}
      className="my-0.5 h-[26px] w-full rounded-[4px] border border-border bg-background px-1.5 text-xs outline-none focus:border-border-strong"
    />
  )
}

/** A chat in the compact rail: its avatar, with Grok's corner status dot. */
function RailRow({ row, active, visible, onMenu }: { row: Row; active: boolean; visible: boolean; onMenu: (row: Row, x: number, y: number) => void }) {
  const live = useLive()
  const { bot, chat } = row
  const members = chat && !bot ? membersOf(chat, live.bots) : []
  const working = bot ? bot.working : !!chat?.speaking
  const needsYou = !!chat?.waitingFor
  const unread = !!chat?.unread && !(active && visible)
  const status = needsYou ? 'Needs attention' : unread ? 'Unread activity' : undefined
  return (
    <Link
      {...(bot ? { to: '/bots/$botId', params: { botId: bot.id } } : { to: '/groups/$chatId', params: { chatId: row.chatId } })}
      title={rowName(row)}
      aria-label={status ? `${rowName(row)}, ${status}` : rowName(row)}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(row, event.clientX, event.clientY)
      }}
      className="relative grid size-11 place-items-center rounded-[10px] transition-colors duration-100 hover:bg-secondary active:bg-selected"
      activeProps={{ className: 'bg-secondary', 'aria-current': 'page' }}
    >
      {bot ? (
        <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} working={working && !needsYou} />
      ) : (
        <GroupAvatar members={members} working={working && !needsYou} />
      )}
      {status && (
        <span
          aria-hidden
          className={cn(
            'absolute top-1.5 right-1.5 size-2 rounded-full border border-sidebar motion-safe:animate-pop-in motion-reduce:animate-fade-in',
            needsYou ? 'bg-status-attention' : 'bg-status-unread',
          )}
        />
      )}
    </Link>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" strokeLinecap="round" />
    </svg>
  )
}

/** The chat the owner has open, if any: a bot's DM or a group chat. */
export function useActiveChatId(): string | undefined {
  const live = useLive()
  const params = useRouterState({
    select: (state) =>
      state.matches.find((match) => match.routeId === '/_app/bots/$botId' || match.routeId === '/_app/groups/$chatId')?.params as
        | { botId?: string; chatId?: string }
        | undefined,
  })
  return params?.chatId ?? live.bots?.find((bot) => bot.id === params?.botId)?.chatId
}

/** "+ New": a bot, a group chat, or a section. */
function NewMenu({
  compact,
  onClose,
  onNewBot,
  onNewGroup,
  onNewSection,
}: {
  compact: boolean
  onClose: () => void
  onNewBot: () => void
  onNewGroup: () => void
  onNewSection: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), [])
  useEffect(() => {
    const close = (event: Event) => {
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose()
    }
    addEventListener('pointerdown', close, true)
    return () => removeEventListener('pointerdown', close, true)
  }, [onClose])
  const items = [
    { label: 'New bot', run: onNewBot },
    { label: 'New group chat', run: onNewGroup },
    { label: 'New section', run: onNewSection },
  ]
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="New"
      onKeyDown={(event) => {
        const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const index = buttons.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          onClose()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
        }
      }}
      className={cn(
        'absolute top-full z-40 mt-1 flex min-w-[170px] flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg motion-safe:animate-pop-in motion-reduce:animate-fade-in',
        compact ? 'left-0' : 'right-0',
      )}
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
          className="rounded-md px-2.5 py-1.5 text-left text-base outline-none hover:bg-secondary focus-visible:bg-secondary"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
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

/** One line of plain text from markdown, for previews. */
function previewText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The row's second line, in Grok's priority: the owner's draft, what the bot waits for, its activity (in a group, the
 * member taking its turn), the latest message.
 */
function secondLine(row: Row, speaking: BotInfo | undefined, draft: string | undefined) {
  const { bot, chat } = row
  if (draft?.trim()) return { label: 'Draft: ', text: previewText(draft), className: 'text-muted-foreground', labelClass: 'text-red-foreground' }
  if (chat?.waitingFor) {
    return { label: 'Waiting for you: ', text: previewText(chat.waitingFor), className: 'text-muted-foreground', labelClass: 'text-amber-foreground' }
  }
  if (bot?.working) return { text: 'Working…', className: 'text-green-foreground' }
  if (bot?.error) return { text: "Couldn't reach its model", className: 'text-red-foreground' }
  if (speaking) return { text: `${speaking.name} is taking a turn…`, className: 'text-green-foreground' }
  const last = chat?.lastMessage
  if (last) {
    const text = previewText(last.text) || (last.attachments.length ? summarizeAttachments(last.attachments) : '')
    // A message between bots shows who it went to or came from: "→ Ana: …", "← Rex: …"; a group's shows who posted it.
    const prefix = last.botMessage
      ? `${last.botMessage.direction === 'to' ? '→' : '←'} ${last.botMessage.name}: `
      : last.author === 'owner'
        ? 'You: '
        : bot
          ? ''
          : `${last.authorName}: `
    return { text: prefix + text, className: 'text-muted-foreground' }
  }
  return { text: bot?.title ?? 'No messages yet', className: 'text-muted-foreground' }
}

function ChatRow({
  row,
  active,
  selected,
  visible,
  now,
  draft,
  renaming,
  dragging,
  onClick,
  onRenamed,
  onStartRename,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  row: Row
  active: boolean
  /** Picked in a multi-select. */
  selected: boolean
  /** The tab is in view, so the open chat is really being read. */
  visible: boolean
  now: number
  draft: string | undefined
  renaming: boolean
  dragging: boolean
  /** Before the row opens its chat: a multi-select click prevents that. */
  onClick: (row: Row, event: MouseEvent) => void
  onRenamed: () => void
  onStartRename: () => void
  onMenu: (row: Row, x: number, y: number) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const live = useLive()
  const { bot, chat, pinned } = row
  const members = chat && !bot ? membersOf(chat, live.bots) : []
  const speaking = members.find((member) => member.id === chat?.speaking)
  const line = secondLine(row, speaking, draft)
  const working = bot ? bot.working : !!speaking
  // The open chat in a visible tab is being read, so it doesn't show as unread.
  const needsYou = !!chat?.waitingFor
  const unread = !!chat?.unread && !(active && visible)
  const status = needsYou ? 'Needs attention' : unread ? 'Unread activity' : undefined

  const avatar = (working: boolean) =>
    bot ? <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} working={working} /> : <GroupAvatar members={members} working={working} />

  if (renaming) return <RenameRow row={row} avatar={avatar(working)} onDone={onRenamed} />

  return (
    <Link
      {...(bot ? { to: '/bots/$botId', params: { botId: bot.id } } : { to: '/groups/$chatId', params: { chatId: row.chatId } })}
      draggable
      aria-selected={selected}
      onClick={(event) => onClick(row, event)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        // Its own type, so dropping the row on the composer types nothing.
        event.dataTransfer.setData('application/x-openbot-chat', row.chatId)
        onDragStart()
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
        selected && 'bg-selected hover:bg-selected',
      )}
      activeProps={{ className: 'bg-secondary', 'aria-current': 'page' }}
    >
      {/* Grok's working state: running and not waiting for the owner. */}
      {avatar(working && !needsYou)}
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1">
          <span
            className={cn('truncate', unread && 'font-semibold')}
            onDoubleClick={(event) => {
              event.preventDefault()
              onStartRename()
            }}
          >
            {rowName(row)}
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

/** Renames a bot or a group chat in place: Enter or leaving the field saves, Esc cancels. */
function RenameRow({ row, avatar, onDone }: { row: Row; avatar: ReactNode; onDone: () => void }) {
  const live = useLive()
  const { bot, chat } = row
  const current = bot?.name ?? chat?.title ?? ''
  const [name, setName] = useState(current)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const settled = useRef(false)

  async function save() {
    const trimmed = name.trim()
    if (settled.current || saving) return
    // A bot needs a name; a group without one is named after its members.
    if ((bot && !trimmed) || trimmed === current) {
      settled.current = true
      return onDone()
    }
    setSaving(true)
    setError(undefined)
    try {
      if (bot) live.updateBot(await api().bots.update({ botId: bot.id, name: trimmed }))
      else live.setChat(await api().groups.update({ chatId: row.chatId, title: trimmed || null }))
      settled.current = true
      onDone()
    } catch (caught) {
      setError(errorMessage(caught))
      setSaving(false)
    }
  }

  return (
    <div className="grid min-h-[58px] grid-cols-[34px_1fr] items-center gap-[9px] rounded-[10px] bg-secondary p-2">
      {avatar}
      <span className="flex min-w-0 flex-col gap-0.5">
        <input
          aria-label={`Rename ${rowName(row)}`}
          autoFocus
          value={name}
          placeholder={bot ? undefined : (chat?.name ?? '')}
          maxLength={bot ? 80 : 120}
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

/** A context menu at (`x`, `y`), kept inside the window; an item with `items` shows them in its place, with Back. */
function Menu({ label, items, x, y, onClose }: { label: string; items: MenuItem[]; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const [opened, setOpened] = useState<MenuItem>()
  const restoreFocus = useRef<Element | null>(null)
  const shown: MenuItem[] = opened ? [{ label: '‹ Back', run: () => setOpened(undefined) }, ...opened.items!] : items

  useLayoutEffect(() => {
    restoreFocus.current ??= document.activeElement
  }, [])

  // Kept inside the window, and focused so the keyboard works at once.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const box = menu.getBoundingClientRect()
    setPosition({ left: Math.min(x, innerWidth - box.width - 8), top: Math.min(y, innerHeight - box.height - 8) })
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [x, y, opened])

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
      aria-label={opened ? opened.label : label}
      style={position}
      onKeyDown={(event) => {
        const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const index = buttons.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          if (opened && event.key === 'Escape') setOpened(undefined)
          else dismiss()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          buttons[(index + step + buttons.length) % buttons.length]?.focus()
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus()
        } else if (event.key === 'ArrowLeft' && opened) {
          event.preventDefault()
          setOpened(undefined)
        } else if (event.key === 'ArrowRight' && shown[index]?.items) {
          event.preventDefault()
          setOpened(shown[index])
        }
      }}
      className="fixed z-40 flex max-h-[min(420px,calc(100vh-16px))] min-w-[180px] flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg motion-safe:animate-pop-in motion-reduce:animate-fade-in"
    >
      {shown.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-haspopup={item.items ? 'menu' : undefined}
          onClick={() => {
            if (item.items) return setOpened(item)
            if (item.label !== '‹ Back') onClose()
            item.run?.()
          }}
          className={cn(
            'flex items-center justify-between gap-4 rounded-md px-2.5 py-1.5 text-left text-base outline-none hover:bg-secondary focus-visible:bg-secondary',
            item.danger && 'text-destructive-foreground',
            item.label === '‹ Back' && 'text-muted-foreground',
          )}
        >
          <span className="truncate">{item.label}</span>
          {item.items && <span aria-hidden className="text-muted-foreground">›</span>}
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
