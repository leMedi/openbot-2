import { avatarColors, avatarShapes, type BotInfo, type NewBot } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { AvatarPicker, Field, followDefault, inputClass, ModelSelect, useModels } from './bot-fields.tsx'

/** Name, title, instructions, avatar and model of a new bot. */
export function NewBotForm({
  onCreated,
  onCancel,
  submitLabel = 'Create bot',
  cancelLabel = 'Cancel',
}: {
  onCreated: (bot: BotInfo) => void
  onCancel?: () => void
  submitLabel?: string
  cancelLabel?: string
}) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [shape, setShape] = useState<NewBot['avatarShape']>(() => avatarShapes[Math.floor(Math.random() * avatarShapes.length)]!)
  const [color, setColor] = useState<NewBot['avatarColor']>(() => avatarColors[Math.floor(Math.random() * avatarColors.length)]!)
  const [model, setModel] = useState(followDefault)
  const { models, defaultModel, error: modelsError } = useModels()
  const [submitError, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const error = submitError ?? modelsError

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setSaving(true)
    try {
      onCreated(
        await api().bots.create({
          name: name.trim(),
          title: title.trim() || null,
          instructions,
          avatarShape: shape,
          avatarColor: color,
          model: model || null,
        }),
      )
    } catch (caught) {
      setError(errorMessage(caught))
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <AvatarPicker
        shape={shape}
        color={color}
        onChange={(change) => ('avatarShape' in change ? setShape(change.avatarShape) : setColor(change.avatarColor))}
      />

      <Field label="Name" htmlFor="bot-name" hint="How you and other bots mention it; no two bots share one.">
        <input id="bot-name" required autoFocus data-autofocus placeholder="Rex" value={name} onChange={(event) => setName(event.target.value)} className={inputClass} />
      </Field>

      <Field label="Title" htmlFor="bot-title">
        <input id="bot-title" placeholder="Describe what your bot does" value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} />
      </Field>

      <Field label="Instructions" htmlFor="bot-instructions" hint="Who the bot is and how it behaves.">
        <textarea
          id="bot-instructions"
          rows={4}
          placeholder="A calm release engineer who fixes builds and explains what went wrong in plain words."
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          className={cn(inputClass, 'resize-y')}
        />
      </Field>

      <Field label="Model" htmlFor="bot-model">
        <ModelSelect id="bot-model" value={model} models={models} defaultModel={defaultModel} onChange={setModel} />
      </Field>

      {error && <p className="text-destructive-foreground">{error}</p>}

      <footer className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover">
            {cancelLabel}
          </button>
        )}
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="pressable rounded-md bg-primary px-3 py-1.5 text-base text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </footer>
    </form>
  )
}
