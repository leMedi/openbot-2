import { avatarColors, avatarShapes, avatarStyles, type BotInfo, type ModelInfo, type ModelSettings } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { avatarPalette, BotAvatar } from './bot-avatar.tsx'

/** The model select's value for "follow the default model". */
export const followDefault = ''

export const inputClass = 'rounded-md border border-input bg-input-fill px-2.5 py-1.5 text-base outline-offset-0'

/** Connected providers' models and the model settings, for a bot's model field. */
export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settings, setSettings] = useState<ModelSettings>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    Promise.all([api().models.list(), api().models.getSettings()]).then(
      ([models, settings]) => {
        setModels(models)
        setSettings(settings)
      },
      (caught) => setError(errorMessage(caught)),
    )
  }, [])

  return { models, defaultModel: models.find((entry) => entry.ref === settings?.defaultModel), error }
}

export type AvatarChange =
  | { avatarStyle: BotInfo['avatarStyle'] }
  | { avatarShape: BotInfo['avatarShape'] }
  | { avatarColor: BotInfo['avatarColor'] }

const styleLabels: Record<BotInfo['avatarStyle'], string> = { critter: 'Critter', bauhaus: 'Bauhaus' }

/** The avatar preview with its style, shape and color pickers. */
export function AvatarPicker({
  style,
  shape,
  color,
  onChange,
}: {
  style: BotInfo['avatarStyle']
  shape: BotInfo['avatarShape']
  color: BotInfo['avatarColor']
  /** Called with the one part that changed. */
  onChange: (change: AvatarChange) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <BotAvatar style={style} shape={shape} color={color} size={56} />
      <div className="flex flex-col gap-2">
        <div className="flex w-fit gap-0.5 rounded-md bg-secondary p-0.5" role="radiogroup" aria-label="Style">
          {avatarStyles.map((entry) => (
            <button
              key={entry}
              type="button"
              role="radio"
              aria-checked={entry === style}
              onClick={() => onChange({ avatarStyle: entry })}
              className={cn(
                'pressable rounded-[5px] px-2 py-0.5 text-xs transition-colors duration-100',
                entry === style ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {styleLabels[entry]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Shape">
          {avatarShapes.map((entry) => (
            <button
              key={entry}
              type="button"
              role="radio"
              aria-checked={entry === shape}
              aria-label={entry}
              onClick={() => onChange({ avatarShape: entry })}
              className={cn('pressable rounded-md p-0.5', entry === shape ? 'bg-selected' : 'hover:bg-secondary')}
            >
              <BotAvatar style={style} shape={entry} color={color} size={22} />
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
              onClick={() => onChange({ avatarColor: entry })}
              className={cn('pressable size-5 rounded-full ring-offset-2 ring-offset-popover', entry === color && 'ring-2 ring-ring')}
              style={{ background: `linear-gradient(135deg, ${avatarPalette[entry].join(', ')})` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** A bot's model: "Default (…)" follows the default model, anything else overrides it. */
export function ModelSelect({
  id,
  value,
  models,
  defaultModel,
  onChange,
}: {
  id: string
  /** A model ref, or `followDefault`. */
  value: string
  models: ModelInfo[]
  defaultModel: ModelInfo | undefined
  onChange: (value: string) => void
}) {
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>
      <option value={followDefault}>Default ({defaultModel?.name ?? 'not chosen yet'})</option>
      {/* An override whose provider was since disconnected. */}
      {value !== followDefault && models.length > 0 && !models.some((entry) => entry.ref === value) && (
        <option value={value} disabled>
          {value} (not available)
        </option>
      )}
      {models.map((entry) => (
        <option key={entry.ref} value={entry.ref}>
          {entry.name} · {entry.provider}
        </option>
      ))}
    </select>
  )
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
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
