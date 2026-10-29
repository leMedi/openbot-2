import type { BotInfo, ChatInfo, RoutineInfo } from '@openbot/api-contract'
import { type ReactNode, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'

/** Asks before deleting something for good, then deletes it with `remove`. */
function ConfirmDelete({
  title,
  children,
  remove,
  onCancel,
  onDeleted,
}: {
  title: string
  /** What deleting it removes. */
  children: ReactNode
  remove: () => Promise<void>
  onCancel: () => void
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string>()

  async function confirm() {
    setDeleting(true)
    setError(undefined)
    try {
      await remove()
      onDeleted()
    } catch (caught) {
      setError(errorMessage(caught))
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl bg-popover p-5 text-popover-foreground shadow-lg"
      >
        <h2 id="confirm-delete-title" className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-base text-muted-foreground">{children}</p>
        {error && <p className="text-destructive-foreground">{error}</p>}
        <footer className="flex justify-end gap-2">
          <button type="button" autoFocus onClick={onCancel} className="rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover">
            Cancel
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => void confirm()}
            className="rounded-md bg-destructive px-3 py-1.5 text-base text-on-color disabled:opacity-50"
          >
            Delete
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Asks before deleting a bot for good (ADR 0009), then deletes it. */
export function ConfirmDeleteBot({ bot, onCancel, onDeleted }: { bot: BotInfo; onCancel: () => void; onDeleted: () => void }) {
  return (
    <ConfirmDelete title={`Delete ${bot.name}?`} remove={() => api().bots.delete({ botId: bot.id })} onCancel={onCancel} onDeleted={onDeleted}>
      This permanently deletes {bot.name}, its DM and history, and removes it from group chats. Its messages in other chats stay,
      marked as deleted. This can't be undone.
    </ConfirmDelete>
  )
}

/** Asks before deleting a group chat for good, then deletes it. */
export function ConfirmDeleteGroup({ chat, onCancel, onDeleted }: { chat: ChatInfo; onCancel: () => void; onDeleted: () => void }) {
  return (
    <ConfirmDelete title={`Delete ${chat.name}?`} remove={() => api().groups.delete({ chatId: chat.id })} onCancel={onCancel} onDeleted={onDeleted}>
      This permanently deletes the group chat, its messages and the files sent in it, and stops its members answering. The
      members stay, and remember what they said in it. This can't be undone.
    </ConfirmDelete>
  )
}

/** Asks before deleting a routine and its run history for good, then deletes it. */
export function ConfirmDeleteRoutine({ routine, onCancel, onDeleted }: { routine: RoutineInfo; onCancel: () => void; onDeleted: () => void }) {
  return (
    <ConfirmDelete
      title={`Delete ${routine.name}?`}
      remove={() => api().routines.delete({ botId: routine.botId, routineId: routine.id })}
      onCancel={onCancel}
      onDeleted={onDeleted}
    >
      This permanently deletes the routine and its run history. Messages it sent stay in the chat. This can't be undone.
    </ConfirmDelete>
  )
}

/** Asks before deleting several chats for good, then deletes them one after another: a DM with its bot (ADR 0009). */
export function ConfirmDeleteChats({
  chats,
  onCancel,
  onDeleted,
}: {
  /** Each chat, with its bot for a DM. */
  chats: readonly { chatId: string; bot?: BotInfo }[]
  onCancel: () => void
  onDeleted: () => void
}) {
  const bots = chats.filter((chat) => chat.bot).length
  return (
    <ConfirmDelete
      title={`Delete ${chats.length} chats?`}
      // The ones deleted before a failure leave the sidebar through their live events.
      remove={async () => {
        for (const chat of chats) {
          if (chat.bot) await api().bots.delete({ botId: chat.bot.id })
          else await api().groups.delete({ chatId: chat.chatId })
        }
      }}
      onCancel={onCancel}
      onDeleted={onDeleted}
    >
      {bots > 0 && `This permanently deletes ${bots === 1 ? 'a bot' : `${bots} bots`} with ${bots === 1 ? 'its DM' : 'their DMs'} and history. `}
      {bots < chats.length && `Group chats lose their messages and files; their members stay. `}
      This can't be undone.
    </ConfirmDelete>
  )
}

/** Asks before deleting a sidebar section, then deletes it; its chats go to Unassigned. */
export function ConfirmDeleteSection({ name, remove, onCancel, onDeleted }: { name: string; remove: () => Promise<void>; onCancel: () => void; onDeleted: () => void }) {
  return (
    <ConfirmDelete title={`Delete “${name}”?`} remove={remove} onCancel={onCancel} onDeleted={onDeleted}>
      Its chats move to Unassigned. No chat is deleted.
    </ConfirmDelete>
  )
}
