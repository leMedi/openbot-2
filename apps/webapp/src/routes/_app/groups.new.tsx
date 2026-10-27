import { type BotInfo, maxGroupMembers, minGroupMembers } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { BotAvatar, GroupAvatar } from '../../components/bot-avatar.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/groups/new')({
  component: NewGroup,
})

/**
 * Slack's new conversation: an empty chat with a "To:" field where bot names become chips. The first message creates
 * the group, named after its members until renamed, and opens it.
 */
function NewGroup() {
  const live = useLive()
  const navigate = useNavigate()
  const [members, setMembers] = useState<BotInfo[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const enough = members.length >= minGroupMembers

  async function send() {
    const draft = text.trim()
    if (!draft || !enough || sending) return
    setSending(true)
    setError(undefined)
    try {
      const { chat, message } = await api().groups.create({ memberIds: members.map((bot) => bot.id), text: draft })
      live.setChat(chat)
      live.addMessage(message)
      navigate({ to: '/groups/$chatId', params: { chatId: chat.id }, replace: true })
    } catch (caught) {
      setError(errorMessage(caught))
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="chat-material flex min-h-[51px] items-center gap-2 px-4">
        <GroupAvatar members={members} />
        <span className="font-semibold">New group chat</span>
      </header>
      <ToField bots={live.bots ?? []} members={members} onChange={setMembers} />
      <p className="m-auto max-w-sm px-6 text-center text-muted-foreground">
        {enough
          ? 'Send a message to start the group. Its members answer in turns; mention @name to ask one of them.'
          : `Add at least ${minGroupMembers} bots to the group.`}
      </p>
      <div className="px-[max(24px,calc((100%-700px)/2))] pt-2 pb-[18px]">
        {error && (
          <p role="alert" className="pb-1 text-sm text-destructive-foreground">
            {error}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
          className="flex items-end gap-2 rounded-2xl border border-border bg-secondary p-[9px] shadow-sm transition-colors duration-100 focus-within:border-border-strong"
        >
          <textarea
            aria-label="Message the group"
            placeholder={enough ? `Message ${members.map((bot) => bot.name).join(', ')}` : 'Message the group'}
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            className="max-h-60 min-h-12 flex-1 resize-none bg-transparent px-1 leading-[1.4] outline-none [field-sizing:content]"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={!text.trim() || !enough || sending}
            className="pressable grid size-[30px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  )
}

/**
 * Slack's "To:" field: typing a name suggests bots; Enter, Tab or a click makes the first match a chip, Backspace in
 * the empty field removes the last chip.
 */
function ToField({ bots, members, onChange }: { bots: BotInfo[]; members: BotInfo[]; onChange: (members: BotInfo[]) => void }) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const full = members.length >= maxGroupMembers
  const matches = full
    ? []
    : bots.filter((bot) => !members.some((member) => member.id === bot.id) && bot.name.toLowerCase().includes(query.trim().toLowerCase().replace(/^@/, '')))
  const open = query.trim().length > 0 && matches.length > 0

  function add(bot: BotInfo | undefined) {
    if (!bot) return
    onChange([...members, bot])
    setQuery('')
    setHighlight(0)
    input.current?.focus()
  }

  return (
    <div className="relative border-b border-border-subtle px-4 py-2">
      <div className="flex flex-wrap items-center gap-1.5" onClick={() => input.current?.focus()}>
        <label htmlFor="group-to" className="text-muted-foreground">
          To:
        </label>
        {members.map((bot) => (
          <span key={bot.id} className="flex items-center gap-1 rounded-full bg-secondary py-0.5 pr-1 pl-1 motion-safe:animate-pop-in motion-reduce:animate-fade-in">
            <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={18} />
            <span className="text-sm">{bot.name}</span>
            <button
              type="button"
              aria-label={`Remove ${bot.name}`}
              onClick={() => onChange(members.filter((member) => member.id !== bot.id))}
              className="pressable grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
        <input
          id="group-to"
          ref={input}
          autoFocus
          role="combobox"
          aria-expanded={open}
          aria-controls="group-to-options"
          aria-autocomplete="list"
          disabled={full}
          placeholder={full ? `Groups can have up to ${maxGroupMembers} members` : members.length ? '' : 'Type a bot’s name'}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setHighlight(0)
          }}
          onKeyDown={(event) => {
            if ((event.key === 'Enter' || event.key === 'Tab') && open) {
              event.preventDefault()
              add(matches[Math.min(highlight, matches.length - 1)])
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              setHighlight((current) => (current + step + matches.length) % Math.max(matches.length, 1))
            } else if (event.key === 'Backspace' && !query && members.length) {
              onChange(members.slice(0, -1))
            } else if (event.key === 'Escape') {
              setQuery('')
            }
          }}
          className="min-w-[120px] flex-1 bg-transparent py-0.5 outline-none"
        />
      </div>
      {open && (
        <ul
          id="group-to-options"
          role="listbox"
          className="absolute top-full left-12 z-30 mt-1 flex min-w-[200px] flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg motion-safe:animate-pop-in motion-reduce:animate-fade-in"
        >
          {matches.map((bot, index) => (
            <li
              key={bot.id}
              role="option"
              aria-selected={index === highlight}
              onPointerDown={(event) => {
                event.preventDefault()
                add(bot)
              }}
              className={cn('flex cursor-default items-center gap-2 rounded-md px-2 py-1.5', index === highlight && 'bg-secondary')}
            >
              <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={20} />
              <span>{bot.name}</span>
              {bot.title && <span className="truncate text-sm text-muted-foreground">{bot.title}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
