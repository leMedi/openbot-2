import { type BotInfo, type ChatInfo, maxGroupMembers, minGroupMembers } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { BotAvatar, GroupAvatar } from '../../components/bot-avatar.tsx'
import { Field, inputClass } from '../../components/bot-fields.tsx'
import { ChatView } from '../../components/chat-view.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { membersOf } from '../../lib/groups.ts'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/groups/$chatId')({
  component: Group,
})

/** A group chat: the owner and its members, who answer in rounds, with the Members pane beside it. */
function Group() {
  const { chatId } = Route.useParams()
  const live = useLive()
  const [membersOpen, setMembersOpen] = useState(false)
  const chat = live.chats.get(chatId)
  if (!chat || chat.kind !== 'group') return live.bots ? <p className="m-auto text-muted-foreground">This group chat doesn't exist.</p> : null
  const members = membersOf(chat, live.bots)
  const speaking = live.bots?.find((bot) => bot.id === chat.speaking)
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatView
          key={chat.id}
          chatId={chat.id}
          header={
            <header className="chat-material sticky top-0 z-10 flex min-h-[51px] items-center gap-2 px-4">
              <GroupAvatar members={members} />
              <span className="truncate font-semibold">{chat.name}</span>
              {speaking && <span className="shrink-0 animate-fade-in text-sm text-muted-foreground">{speaking.name} is taking a turn</span>}
              <span className="ml-auto flex gap-1">
                <button
                  type="button"
                  aria-pressed={membersOpen}
                  onClick={() => setMembersOpen((open) => !open)}
                  className={cn('pressable rounded-md px-2 py-1 text-base hover:bg-secondary-hover', membersOpen && 'bg-selected')}
                >
                  Members
                </button>
              </span>
            </header>
          }
          composerLabel={`Message ${chat.name}`}
          emptyText="Say hi to the group. Mention @name to ask one member, or @everyone."
          typing={speaking}
          allowFiles={false}
          showAuthors
        />
      </div>
      {membersOpen && <MembersPane chat={chat} members={members} />}
    </div>
  )
}

/** The group's name and members, Grok's Members pane: rename, open a member's DM, remove one, add another. */
function MembersPane({ chat, members }: { chat: ChatInfo; members: BotInfo[] }) {
  const live = useLive()
  const [title, setTitle] = useState(chat.title ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  // Renamed elsewhere: show the new name.
  useEffect(() => setTitle(chat.title ?? ''), [chat.title])
  const others = (live.bots ?? []).filter((bot) => !chat.members.includes(bot.id))

  async function save(changes: { title?: string | null; memberIds?: string[] }) {
    setSaving(true)
    setError(undefined)
    try {
      live.setChat(await api().groups.update({ chatId: chat.id, ...changes }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  function saveTitle() {
    const next = title.trim() || null
    if (next !== chat.title) void save({ title: next })
  }

  return (
    <aside aria-label="Members" className="flex w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Members</h2>
        <span role="status" className={cn('text-sm', error ? 'text-destructive-foreground' : 'text-muted-foreground')}>
          {saving ? 'Saving…' : error ? "Couldn't save" : ''}
        </span>
      </header>

      <Field label="Name" htmlFor="group-name" hint="Leave it blank to name the group after its members.">
        <input
          id="group-name"
          value={title}
          maxLength={120}
          placeholder={chat.name ?? ''}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              saveTitle()
            }
          }}
          className={inputClass}
        />
      </Field>

      <ul className="flex flex-col gap-1">
        {members.map((bot) => (
          <li key={bot.id} className="flex items-center gap-2 rounded-md px-1 py-1">
            <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={24} working={bot.working} />
            <Link to="/bots/$botId" params={{ botId: bot.id }} className="min-w-0 flex-1 truncate hover:underline">
              {bot.name}
            </Link>
            <button
              type="button"
              disabled={saving || chat.members.length <= minGroupMembers}
              title={chat.members.length <= minGroupMembers ? `A group chat needs at least ${minGroupMembers} bots` : undefined}
              onClick={() => {
                if (confirm(`Remove ${bot.name} from this group chat?`)) void save({ memberIds: chat.members.filter((id) => id !== bot.id) })
              }}
              className="pressable rounded-md px-2 py-0.5 text-sm text-destructive-foreground hover:bg-secondary disabled:opacity-40"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <Field label="Add member" htmlFor="group-add">
        <select
          id="group-add"
          value=""
          disabled={saving || !others.length || chat.members.length >= maxGroupMembers}
          onChange={(event) => event.target.value && void save({ memberIds: [...chat.members, event.target.value] })}
          className={inputClass}
        >
          <option value="">
            {chat.members.length >= maxGroupMembers
              ? `Groups can have up to ${maxGroupMembers} members.`
              : others.length
                ? 'Choose a bot…'
                : 'Create more bots to add them here.'}
          </option>
          {others.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </Field>

      {error && <p className="text-sm text-destructive-foreground">{error}</p>}
    </aside>
  )
}
