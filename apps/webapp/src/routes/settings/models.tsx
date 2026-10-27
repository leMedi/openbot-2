import type { ModelInfo, ModelSettings } from '@openbot/api-contract'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/models')({
  component: Models,
})

const sameAsDefault = ''

function Models() {
  const [models, setModels] = useState<ModelInfo[]>()
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

  async function update(changes: Partial<ModelSettings>) {
    setError(undefined)
    try {
      setSettings(await api().models.updateSettings(changes))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const defaultModel = models?.find((model) => model.ref === settings?.defaultModel)

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-xl font-semibold">Models</h2>
        <p className="text-base text-muted-foreground">
          Models come from <Link to="/settings/providers" className="text-link underline">connected providers</Link>.
        </p>
      </header>

      {error && <p className="text-destructive-foreground">{error}</p>}
      {models?.length === 0 && <p className="text-muted-foreground">Connect a provider to choose models.</p>}

      {models && settings && models.length > 0 && (
        <>
          <ModelField
            label="Default model"
            description="Every bot uses this model unless it has its own."
            value={settings.defaultModel ?? sameAsDefault}
            models={models}
            placeholder="Choose a model"
            onChange={(ref) => update({ defaultModel: ref || null })}
          />
          <ModelField
            label="Computer-use model"
            description="Drives bots' screens, so it must understand images."
            value={settings.computerUseModel ?? sameAsDefault}
            models={models.filter((model) => model.vision)}
            placeholder={defaultModel ? `Same as default (${defaultModel.name})` : 'Same as default'}
            onChange={(ref) => update({ computerUseModel: ref || null })}
          />
          {!settings.computerUseModel && defaultModel && !defaultModel.vision && (
            <p className="text-sm text-amber-foreground">
              {defaultModel.name} can't see images; choose a computer-use model so bots can use their screens.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function ModelField({
  label,
  description,
  value,
  models,
  placeholder,
  onChange,
}: {
  label: string
  description: string
  value: string
  models: ModelInfo[]
  placeholder: string
  onChange: (ref: string) => void
}) {
  const id = label.toLowerCase().replaceAll(' ', '-')
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-lg font-medium">
        {label}
      </label>
      <p className="text-sm text-muted-foreground">{description}</p>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-input bg-input-fill px-2.5 py-1.5 text-base outline-offset-0"
      >
        <option value={sameAsDefault}>{placeholder}</option>
        {/* A chosen model whose provider was since disconnected. */}
        {value !== sameAsDefault && !models.some((model) => model.ref === value) && (
          <option value={value} disabled>
            {value} (not available)
          </option>
        )}
        {models.map((model) => (
          <option key={model.ref} value={model.ref}>
            {model.name} · {model.provider}
          </option>
        ))}
      </select>
    </div>
  )
}
