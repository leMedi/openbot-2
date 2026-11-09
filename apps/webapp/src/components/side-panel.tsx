import { cn } from '@openbot/ui/lib/utils'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useId, useRef } from 'react'
import { usePhone } from '../lib/sidebar-prefs.ts'

const iconProps = { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/**
 * The panel on a chat's right: its tabs (a bot's Screen, Profile, Routines, Memory and Access; a group's Members) over
 * the open one. Beside the chat on a wide window; on a phone it covers the chat, and Close goes back to it.
 */
export function SidePanel<Tab extends string>({
  label,
  tabs,
  tab,
  onTab,
  onClose,
  children,
}: {
  label: string
  tabs: readonly { id: Tab; label: string }[]
  tab: Tab
  onTab: (tab: Tab) => void
  onClose: () => void
  children: ReactNode
}) {
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const phone = usePhone()
  return (
    <aside
      aria-label={label}
      className={cn(
        'flex flex-col bg-background',
        phone ? 'safe-area fixed inset-0 z-30 motion-safe:animate-rise-in motion-reduce:animate-fade-in' : 'w-[360px] shrink-0 border-l border-border-subtle',
      )}
    >
      <div className="flex min-h-[51px] shrink-0 items-center gap-1 border-b border-border-subtle px-3">
        <div
          ref={list}
          role="tablist"
          aria-label={label}
          className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none]"
          onKeyDown={(event) => {
            // Arrows move between tabs, as in any tab list.
            const index = tabs.findIndex((entry) => entry.id === tab)
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
            if (!step) return
            event.preventDefault()
            const next = tabs[(index + step + tabs.length) % tabs.length]
            onTab(next.id)
            list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
          }}
        >
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`${id}-${entry.id}`}
              data-tab={entry.id}
              aria-selected={entry.id === tab}
              aria-controls={`${id}-panel`}
              tabIndex={entry.id === tab ? 0 : -1}
              onClick={() => onTab(entry.id)}
              className={cn(
                'pressable shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-secondary-hover hover:text-foreground',
                entry.id === tab && 'bg-selected text-foreground',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Close panel" onClick={onClose} className="pressable -mr-1 shrink-0 rounded-md p-1.5 hover:bg-secondary-hover">
          <svg {...iconProps} aria-hidden>
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </aside>
  )
}

/** The chat header's button that shows and hides its side panel. */
export function PanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={open ? 'Hide panel' : 'Show panel'}
      aria-pressed={open}
      onClick={onToggle}
      className={cn('pressable rounded-md p-1.5 text-muted-foreground hover:bg-secondary-hover hover:text-foreground', open && 'bg-selected text-foreground')}
    >
      <svg {...iconProps} aria-hidden>
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
        <path d="M10 2.75v10.5" />
      </svg>
    </button>
  )
}

/** On a phone, where the chat list is its own page, the chat header's way back to it. */
export function BackToChats() {
  const phone = usePhone()
  if (!phone) return null
  return (
    <Link to="/" aria-label="Chats" className="pressable -ml-2 shrink-0 rounded-md p-1.5 hover:bg-secondary-hover">
      <svg {...iconProps} width={18} height={18} aria-hidden>
        <path d="M10 3.5 5.5 8l4.5 4.5" />
      </svg>
    </Link>
  )
}
