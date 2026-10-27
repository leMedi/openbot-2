import {
  avatarColors,
  avatarShapes,
  type BotInfo,
  type ModelInfo,
  type ModelSettings,
  type NewBot,
} from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { avatarPalette, BotAvatar } from './bot-avatar.tsx'

const followDefault = ''

const inputClass = 'rounded-md border border-input bg-input-fill px-2.5 py-1.5 text-base outline-offset-0'

/** Name, title, instructions, avatar and model of a new bot. */
export function NewBotForm({
  onCreated,
  onCancel,
  submitLabel = 'Create bot',
}: {
  onCreated: (bot: BotInfo) => void
  onCancel?: () => void
  submitLabel?: string
}) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [shape, setShape] = useState<NewBot['avatarShape']>(() => avatarShapes[Math.floor(Math.random() * avatarShapes.length)]!)
  const [color, setColor] = useState<NewBot['avatarColor']>(() => avatarColors[Math.floor(Math.random() * avatarColors.length)]!)
  const [model, setModel] = useState(followDefault)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settings, setSettings] = useState<ModelSettings>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all([api().models.list(), api().models.getSettings()]).then(
      ([models, settings]) => {
        setModels(models)
        setSettings(settings)
      },
      (caught) => setError(errorMessage(caught)),
    )
  }, [])

  const defaultModel = models.find((entry) => entry.ref === settings?.defaultModel)

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
      <div className="flex items-center gap-3">
        <BotAvatar shape={shape} color={color} size={56} />
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Shape">
            {avatarShapes.map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={entry === shape}
                aria-label={entry}
                onClick={() => setShape(entry)}
                className={cn('pressable rounded-md p-0.5', entry === shape ? 'bg-selected' : 'hover:bg-secondary')}
              >
                <BotAvatar shape={entry} color={color} size={22} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Color">
            {avatarColors.map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={entry === color}
                aria-label={entry}
                onClick={() => setColor(entry)}
                className={cn('pressable size-5 rounded-full ring-offset-2 ring-offset-popover', entry === color && 'ring-2 ring-ring')}
                style={{ background: `linear-gradient(135deg, ${avatarPalette[entry].join(', ')})` }}
              />
            ))}
          </div>
        </div>
      </div>

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
        <select id="bot-model" value={model} onChange={(event) => setModel(event.target.value)} className={inputClass}>
          <option value={followDefault}>Default ({defaultModel?.name ?? 'not chosen yet'})</option>
          {models.map((entry) => (
            <option key={entry.ref} value={entry.ref}>
              {entry.name} · {entry.provider}
            </option>
          ))}
        </select>
      </Field>

      {error && <p className="text-destructive-foreground">{error}</p>}

      <footer className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover">
            Cancel
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

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}
