import type { ChatInfo, FileHit, MessageHit, RoutineInfo, SearchResults } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { runCommand, useCommand } from '../lib/commands.ts'
import { useLive, type LiveStore } from '../lib/live.tsx'
import { hitDetail, type PaletteTab, paletteTabs, rankByMatch } from '../lib/palette.ts'
import { describeSchedule } from '../lib/schedule.ts'
import { adjacentChat, navigableChatIds, sidebarLayout } from '../lib/sidebar.ts'
import { sidebarPrefs } from '../lib/sidebar-prefs.ts'
import { useActiveChatId } from './sidebar.tsx'

const tabLabels: Record<PaletteTab, string> = {
  all: 'All',
  messages: 'Messages',
  chats: 'Chats',
  files: 'Files',
  routines: 'Routines',
  actions: 'Actions',
}

/** How many entries of each kind the All tab shows. */
const allTabLimit = 5

/** How long typing pauses before the server is searched. */
const searchDelayMs = 150

/** One palette row: an icon, a label, its detail on the right, and what Enter does. */
type Entry = { key: string; icon: EntryIcon; label: ReactNode; detail: string; run: () => void }
type EntryIcon = 'bot' | 'group' | 'message' | 'file' | 'routine' | 'action'

/** Whether a key press is typing into a field, where the app's shortcuts other than ⌘K stay out of the way. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

/** A chat's name, as the sidebar shows it. */
function chatName(live: LiveStore, chat: ChatInfo): string {
  return chat.kind === 'dm' ? (live.bots?.find((bot) => bot.id === chat.botId)?.name ?? '') : (chat.name ?? '')
}

/**
 * Grok's ⌘K palette, and the app's other shortcuts: ⌘⇧F (the palette on Chats), ⌘B (the compact rail), ⌥↑ / ⌥↓
 * (the previous or next chat in the sidebar) and ⌘, (Settings). Ctrl stands in for ⌘ off a Mac.
 */
export function CommandPalette() {
  const live = useLive()
  const navigate = useNavigate()
  const activeChatId = useActiveChatId()
  const [open, setOpen] = useState<{ tab: PaletteTab; at: number }>()

  useCommand('open-palette', (tab) => setOpen({ tab, at: Date.now() }))

  const latest = useRef({ live, activeChatId, open })
  latest.current = { live, activeChatId, open }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (mod && !event.shiftKey && !event.altKey && key === 'k') {
        event.preventDefault()
        setOpen((current) => (current ? undefined : { tab: 'all', at: Date.now() }))
        return
      }
      if (typing(event)) return
      if (mod && event.shiftKey && !event.altKey && key === 'f') {
        event.preventDefault()
        setOpen({ tab: 'chats', at: Date.now() })
      } else if (mod && !event.shiftKey && !event.altKey && key === 'b') {
        event.preventDefault()
        sidebarPrefs.setCompact(!sidebarPrefs.compact)
      } else if (mod && !event.shiftKey && !event.altKey && key === ',') {
        event.preventDefault()
        void navigate({ to: '/settings/general' })
      } else if (event.altKey && !mod && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const { live, activeChatId } = latest.current
        const layout = sidebarLayout(live.bots ?? [], live.chats, live.sections, sidebarPrefs.folds)
        const next = adjacentChat(navigableChatIds(layout), activeChatId, event.key === 'ArrowDown' ? 1 : -1)
        const chat = next && live.chats.get(next)
        if (!chat) return
        event.preventDefault()
        openChat(chat)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  function openChat(chat: ChatInfo, message?: string) {
    const search = message ? { message } : {}
    if (chat.kind === 'dm' && chat.botId) void navigate({ to: '/bots/$botId', params: { botId: chat.botId }, search })
    else void navigate({ to: '/groups/$chatId', params: { chatId: chat.id }, search })
  }

  if (!open) return null
  return <Palette key={open.at} initialTab={open.tab} onOpenChat={openChat} onClose={() => setOpen(undefined)} />
}

function Palette({
  initialTab,
  onOpenChat,
  onClose,
}: {
  initialTab: PaletteTab
  onOpenChat: (chat: ChatInfo, message?: string) => void
  onClose: () => void
}) {
  const live = useLive()
  const navigate = useNavigate()
  const [tab, setTab] = useState(initialTab)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [routines, setRoutines] = useState<RoutineInfo[]>()
  const [results, setResults] = useState<{ query: string; found: SearchResults } | { query: string; failed: true }>()
  const list = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<Element | null>(null)
  const now = Date.now()

  useLayoutEffect(() => {
    restoreFocus.current = document.activeElement
  }, [])

  function close() {
    onClose()
    if (restoreFocus.current instanceof HTMLElement && restoreFocus.current.isConnected) restoreFocus.current.focus()
  }

  // Every bot's routines, read once the palette opens.
  const botIds = (live.bots ?? []).map((bot) => bot.id).join()
  useEffect(() => {
    let current = true
    Promise.all((live.bots ?? []).map((bot) => api().routines.list({ botId: bot.id })))
      .then((lists) => current && setRoutines(lists.flat()))
      .catch(() => current && setRoutines([]))
    return () => {
      current = false
    }
  }, [botIds]) // `live.bots` changes on every status update; only the bots themselves matter here.

  // Messages and files come from the server's search, once typing pauses.
  const trimmed = query.trim()
  const searches = tab === 'all' || tab === 'messages' || tab === 'files'
  useEffect(() => {
    if (!searches || !trimmed) return
    let current = true
    const timer = setTimeout(() => {
      api()
        .chats.search({ query: trimmed })
        .then(
          (found) => current && setResults({ query: trimmed, found }),
          () => current && setResults({ query: trimmed, failed: true }),
        )
    }, searchDelayMs)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [trimmed, searches])

  const chats = [...live.chats.values()]
    .flatMap((chat) => {
      const name = chatName(live, chat)
      return name ? [{ chat, name }] : []
    })
    // The latest active first.
    .sort((a, b) => (b.chat.lastMessage?.createdAt ?? 0) - (a.chat.lastMessage?.createdAt ?? 0))

  const chatEntries = rankByMatch(chats, (entry) => entry.name, query).map(
    ({ chat, name }): Entry => ({
      key: `chat:${chat.id}`,
      icon: chat.kind === 'dm' ? 'bot' : 'group',
      label: name,
      detail: chat.hidden ? `${chat.kind === 'dm' ? 'Bot' : 'Group'} · Hidden` : chat.kind === 'dm' ? 'Bot' : 'Group',
      run: () => onOpenChat(chat),
    }),
  )

  const actions: { label: string; run: () => void }[] = [
    { label: 'New bot', run: () => runCommand('new-bot') },
    { label: 'New group chat', run: () => void navigate({ to: '/groups/new' }) },
    { label: 'New section', run: () => runCommand('new-section') },
    { label: 'Show hidden chats', run: () => showHiddenChats() },
    { label: 'Toggle compact sidebar', run: () => sidebarPrefs.setCompact(!sidebarPrefs.compact) },
    { label: 'Settings: General', run: () => void navigate({ to: '/settings/general' }) },
    { label: 'Settings: Providers', run: () => void navigate({ to: '/settings/providers' }) },
    { label: 'Settings: Models', run: () => void navigate({ to: '/settings/models' }) },
    { label: 'Settings: Shared memory', run: () => void navigate({ to: '/settings/shared-memory' }) },
    { label: 'Plugins', run: () => void navigate({ to: '/settings/plugins' }) },
  ]
  const actionEntries = rankByMatch(actions, (action) => action.label, query).map(
    (action): Entry => ({ key: `action:${action.label}`, icon: 'action', label: action.label, detail: 'Action', run: action.run }),
  )

  const botNames = new Map((live.bots ?? []).map((bot) => [bot.id, bot.name]))
  const routineEntries = rankByMatch(routines ?? [], (routine) => `${routine.name} ${botNames.get(routine.botId) ?? ''}`, query).map(
    (routine): Entry => ({
      key: `routine:${routine.id}`,
      icon: 'routine',
      label: routine.name,
      detail: [botNames.get(routine.botId), routine.enabled ? describeSchedule(routine.schedule) : 'Paused'].filter(Boolean).join(' · '),
      run: () => void navigate({ to: '/bots/$botId', params: { botId: routine.botId }, search: { routine: routine.id } }),
    }),
  )

  const found = results && results.query === trimmed && 'found' in results ? results.found : undefined
  const searchFailed = !!results && results.query === trimmed && 'failed' in results
  const hitChat = (hit: MessageHit | FileHit) => {
    const chat = live.chats.get(hit.chatId)
    return chat && { chat, name: chatName(live, chat) }
  }
  const messageEntries = (found?.messages ?? []).flatMap((hit): Entry[] => {
    const where = hitChat(hit)
    if (!where) return []
    return [
      {
        key: `message:${hit.messageId}`,
        icon: 'message',
        label: <Snippet parts={hit.snippet} />,
        detail: hitDetail(hit, { kind: where.chat.kind, name: where.name }, now),
        run: () => onOpenChat(where.chat, hit.messageId),
      },
    ]
  })
  const fileEntries = (found?.files ?? []).flatMap((hit): Entry[] => {
    const where = hitChat(hit)
    if (!where) return []
    return [
      {
        key: `file:${hit.messageId}:${hit.attachment.id}`,
        icon: 'file',
        label: hit.attachment.name,
        detail: where.name,
        run: () => onOpenChat(where.chat, hit.messageId),
      },
    ]
  })

  /** The rows of the open tab, under their headings on All. */
  const sections: { heading?: string; entries: Entry[] }[] =
    tab === 'all'
      ? trimmed
        ? [
            { heading: 'Chats', entries: chatEntries.slice(0, allTabLimit) },
            { heading: 'Actions', entries: actionEntries.slice(0, allTabLimit) },
            { heading: 'Routines', entries: routineEntries.slice(0, allTabLimit) },
            { heading: 'Messages', entries: messageEntries.slice(0, allTabLimit) },
            { heading: 'Files', entries: fileEntries.slice(0, allTabLimit) },
          ]
        : [{ heading: 'Chats', entries: chatEntries.slice(0, 8) }]
      : [
          {
            entries: {
              messages: trimmed ? messageEntries : [],
              chats: chatEntries,
              files: trimmed ? fileEntries : [],
              routines: routineEntries,
              actions: actionEntries,
            }[tab],
          },
        ]
  const entries = sections.flatMap((section) => section.entries)
  const selected = Math.min(active, Math.max(0, entries.length - 1))

  const emptyText = searchFailed
    ? 'Search unavailable — Try again in a moment.'
    : tab === 'messages' && !trimmed
      ? 'Search messages'
      : tab === 'files' && !trimmed
        ? 'Search files'
        : tab === 'routines' && !trimmed && routines?.length === 0
          ? 'No routines yet'
          : tab === 'chats' && !chats.length
            ? 'No chats yet'
            : searches && trimmed && !found
              ? 'Searching…'
              : 'No results'

  useEffect(() => setActive(0), [query, tab])

  useLayoutEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  function showHiddenChats() {
    sidebarPrefs.showHidden()
    requestAnimationFrame(() => document.getElementById('sidebar-hidden')?.scrollIntoView({ block: 'nearest' }))
  }

  function run(entry: Entry | undefined) {
    if (!entry) return
    onClose()
    entry.run()
  }

  function switchTab(step: 1 | -1) {
    const index = paletteTabs.indexOf(tab)
    setTab(paletteTabs[(index + step + paletteTabs.length) % paletteTabs.length]!)
  }

  let index = 0
  return (
    <div
      className="fixed inset-0 z-[3000] flex items-start justify-center px-4 pt-[12vh]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="flex w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border-[0.5px] border-border bg-popover text-popover-foreground shadow-lg motion-safe:animate-pop-in"
      >
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={entries[selected] ? `palette-${selected}` : undefined}
          aria-label="Search"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (!entries.length) return
              const step = event.key === 'ArrowDown' ? 1 : -1
              setActive((selected + step + entries.length) % entries.length)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              run(entries[selected])
            } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !query) {
              event.preventDefault()
              switchTab(event.key === 'ArrowRight' ? 1 : -1)
            } else if (event.key === 'Tab') {
              event.preventDefault()
              switchTab(event.shiftKey ? -1 : 1)
            }
          }}
          className="border-b border-border-subtle bg-transparent py-3.5 pr-2.5 pl-3.5 text-base outline-none placeholder:text-muted-foreground"
        />
        <div role="tablist" aria-label="Search in" className="flex gap-1 overflow-x-auto border-b border-border-subtle px-2 py-1.5">
          {paletteTabs.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              tabIndex={-1}
              aria-selected={entry === tab}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => setTab(entry)}
              className={cn(
                'shrink-0 rounded-md px-2 py-1 text-sm transition-colors duration-100',
                entry === tab ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary',
              )}
            >
              {tabLabels[entry]}
            </button>
          ))}
        </div>
        <div ref={list} id="palette-list" role="listbox" aria-label={tabLabels[tab]} className="h-[360px] overflow-y-auto p-1.5">
          {entries.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>}
          {sections.map(
            (section) =>
              section.entries.length > 0 && (
                <div key={section.heading ?? tab} role="group" aria-label={section.heading}>
                  {section.heading && <p className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">{section.heading}</p>}
                  {section.entries.map((entry) => {
                    const at = index++
                    return (
                      <div
                        key={entry.key}
                        id={`palette-${at}`}
                        data-index={at}
                        role="option"
                        aria-selected={at === selected}
                        onPointerMove={() => at !== selected && setActive(at)}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => run(entry)}
                        className={cn('flex h-[49px] cursor-default items-center gap-3 rounded-lg px-2.5', at === selected && 'bg-secondary')}
                      >
                        <PaletteIcon icon={entry.icon} />
                        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{entry.detail}</span>
                      </div>
                    )
                  })}
                </div>
              ),
          )}
        </div>
      </div>
    </div>
  )
}

/** A message hit's text, its matched words marked. */
function Snippet({ parts }: { parts: MessageHit['snippet'] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-[3px] bg-blue-subtle px-px text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

function PaletteIcon({ icon }: { icon: EntryIcon }) {
  const paths: Record<EntryIcon, ReactNode> = {
    bot: <circle cx="8" cy="8" r="5" />,
    group: (
      <>
        <circle cx="5.5" cy="8" r="3" />
        <circle cx="10.5" cy="8" r="3" />
      </>
    ),
    message: <path d="M3 4h10v7H7l-3 2.5V11H3z" strokeLinejoin="round" />,
    file: <path d="M4.5 2.5h4.5l3 3v8h-7.5zM9 2.5v3h3" strokeLinejoin="round" />,
    routine: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" strokeLinecap="round" />
      </>
    ),
    action: <path d="M9 2 4 9h4l-1 5 5-7H8z" strokeLinejoin="round" />,
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 text-muted-foreground">
      {paths[icon]}
    </svg>
  )
}
