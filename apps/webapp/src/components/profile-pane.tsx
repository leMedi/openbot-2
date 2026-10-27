import type { BotChanges, BotInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { AvatarPicker, Field, followDefault, inputClass, ModelSelect, useModels } from './bot-fields.tsx'

/** Typing pauses this long before a text field saves. */
const saveDelayMs = 600

type TextFields = { name: string; title: string; instructions: string }

const textFields = (bot: BotInfo): TextFields => ({ name: bot.name, title: bot.title ?? '', instructions: bot.instructions })

/**
 * A bot's name, title, instructions, avatar and model, saved as the owner edits them like Grok Bot's forms; there is
 * no Save button. Text saves once typing pauses or the field loses focus; pickers save at once.
 */
export function ProfilePane({ bot, onSaved, onDeleted }: { bot: BotInfo; onSaved: (bot: BotInfo) => void; onDeleted: () => void }) {
  const { models, defaultModel, error: modelsError } = useModels()
  const [text, setText] = useState(() => textFields(bot))
  const [status, setStatus] = useState<{ saving: boolean; error?: string }>({ saving: false })
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const pending = useRef<{ changes: BotChanges; timer?: ReturnType<typeof setTimeout> }>({ changes: {} })
  // Edits made to each text field, and how many of them are saved; a field with unsaved edits keeps what was typed.
  const edits = useRef<Record<keyof TextFields, number>>({ name: 0, title: 0, instructions: 0 })
  const savedEdits = useRef<Record<keyof TextFields, number>>({ name: 0, title: 0, instructions: 0 })
  // Each save is sent after the previous one, so they land in the order the owner made them.
  const queue = useRef(Promise.resolve())

  // Another bot's profile, or this one edited elsewhere: show it as it is, keeping unsaved typing.
  const shownBot = useRef(bot.id)
  useEffect(() => {
    if (shownBot.current !== bot.id) {
      shownBot.current = bot.id
      edits.current = { name: 0, title: 0, instructions: 0 }
      savedEdits.current = { ...edits.current }
      setText(textFields(bot))
      setStatus({ saving: false })
      return
    }
    const saved = textFields(bot)
    const unsaved = (field: keyof TextFields) => edits.current[field] !== savedEdits.current[field]
    setText((current) => ({
      name: unsaved('name') ? current.name : saved.name,
      title: unsaved('title') ? current.title : saved.title,
      instructions: unsaved('instructions') ? current.instructions : saved.instructions,
    }))
  }, [bot])

  function save(changes: BotChanges) {
    const botId = bot.id
    const made = { ...edits.current }
    const shown = () => shownBot.current === botId
    setStatus({ saving: true })
    queue.current = queue.current.then(async () => {
      try {
        const updated = await api().bots.update({ botId, ...changes })
        if (shown()) {
          for (const field of ['name', 'title', 'instructions'] as const) {
            if (field in changes) savedEdits.current[field] = Math.max(savedEdits.current[field], made[field])
          }
          setStatus({ saving: false })
        }
        onSaved(updated)
      } catch (caught) {
        if (shown()) setStatus({ saving: false, error: errorMessage(caught) })
      }
    })
  }

  function flush() {
    const { changes, timer } = pending.current
    clearTimeout(timer)
    pending.current = { changes: {} }
    if (Object.keys(changes).length > 0) save(changes)
  }

  // Unsaved typing is saved when the owner moves to another bot or closes the pane.
  useEffect(() => flush, [bot.id])

  function edit(field: keyof TextFields, value: string) {
    setText((current) => ({ ...current, [field]: value }))
    edits.current[field]++
    const trimmed = value.trim()
    const changes = pending.current.changes
    // A name can't be blank: nothing is saved until there is a new one, and leaving it blank puts the old one back.
    if (field === 'name' && !trimmed) delete changes.name
    else if (field === 'name') changes.name = trimmed
    if (field === 'title') changes.title = trimmed || null
    if (field === 'instructions') changes.instructions = value
    clearTimeout(pending.current.timer)
    pending.current.timer = setTimeout(flush, saveDelayMs)
  }

  function blurName() {
    if (!text.name.trim()) {
      savedEdits.current.name = edits.current.name
      setText((current) => ({ ...current, name: bot.name }))
    }
    flush()
  }

  function deleted() {
    // Nothing is left to save.
    clearTimeout(pending.current.timer)
    pending.current = { changes: {} }
    onDeleted()
  }

  return (
    <aside aria-label={`${bot.name}'s profile`} className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Profile</h2>
        <span role="status" className={cn('text-sm', status.error ? 'text-destructive-foreground' : 'text-muted-foreground')}>
          {status.saving ? 'Saving…' : status.error ? "Couldn't save" : ''}
        </span>
      </header>

      <AvatarPicker shape={bot.avatarShape} color={bot.avatarColor} onChange={(change) => save(change)} />

      <Field label="Name" htmlFor="profile-name" hint="How you and other bots mention it; no two bots share one.">
        <input id="profile-name" value={text.name} onChange={(event) => edit('name', event.target.value)} onBlur={blurName} className={inputClass} />
      </Field>

      <Field label="Title" htmlFor="profile-title">
        <input
          id="profile-title"
          placeholder="Describe what your bot does"
          value={text.title}
          onChange={(event) => edit('title', event.target.value)}
          onBlur={flush}
          className={inputClass}
        />
      </Field>

      <Field label="Instructions" htmlFor="profile-instructions" hint="Who the bot is and how it behaves.">
        <textarea
          id="profile-instructions"
          rows={8}
          value={text.instructions}
          onChange={(event) => edit('instructions', event.target.value)}
          onBlur={flush}
          className={cn(inputClass, 'resize-y')}
        />
      </Field>

      <Field label="Model" htmlFor="profile-model">
        <div className="flex gap-2">
          <ModelSelect
            id="profile-model"
            value={bot.model ?? followDefault}
            models={models}
            defaultModel={defaultModel}
            onChange={(ref) => save({ model: ref || null })}
          />
          {bot.model && (
            <button type="button" onClick={() => save({ model: null })} className="rounded-md px-2 text-sm text-link hover:bg-secondary">
              Use default
            </button>
          )}
        </div>
      </Field>

      {(status.error ?? modelsError) && <p className="text-sm text-destructive-foreground">{status.error ?? modelsError}</p>}

      <footer className="mt-auto border-t border-border-subtle pt-4">
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          className="rounded-md px-3 py-1.5 text-base text-destructive-foreground hover:bg-secondary"
        >
          Delete bot
        </button>
      </footer>

      {confirmingDelete && <ConfirmDelete bot={bot} onCancel={() => setConfirmingDelete(false)} onDeleted={deleted} />}
    </aside>
  )
}

function ConfirmDelete({ bot, onCancel, onDeleted }: { bot: BotInfo; onCancel: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string>()

  async function remove() {
    setDeleting(true)
    setError(undefined)
    try {
      await api().bots.delete({ botId: bot.id })
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
        aria-labelledby="delete-bot-title"
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl bg-popover p-5 text-popover-foreground shadow-lg"
      >
        <h2 id="delete-bot-title" className="text-lg font-semibold">
          Delete {bot.name}?
        </h2>
        <p className="text-base text-muted-foreground">
          This permanently deletes {bot.name}, its DM and history, and removes it from group chats. Its messages in other chats stay,
          marked as deleted. This can't be undone.
        </p>
        {error && <p className="text-destructive-foreground">{error}</p>}
        <footer className="flex justify-end gap-2">
          <button type="button" autoFocus onClick={onCancel} className="rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover">
            Cancel
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => void remove()}
            className="rounded-md bg-destructive px-3 py-1.5 text-base text-on-color disabled:opacity-50"
          >
            Delete
          </button>
        </footer>
      </div>
    </div>
  )
}
