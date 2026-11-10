import type { ModelInfo, ModelSettings } from '@openbot/api-contract'
import { useCallback } from 'react'
import { useInstance } from '../lib/instance-context.ts'
import { openOnWeb } from '../lib/open-on-web.ts'
import { useLoadOnFocus } from '../lib/use-load.ts'
import { Group, GroupedScroll, Loading, Note, Row } from './grouped.tsx'

/** The connected providers' models and the model settings, for a bot's model. */
export function useBotModels() {
  const { api } = useInstance()
  return useLoadOnFocus(useCallback(() => Promise.all([api.models.list(), api.models.getSettings()]), [api]))
}

/** A bot's model as its row shows it: "Default (…)" when it follows the default, else its name (or ref, once gone). */
export function botModelLabel(ref: string | null, models: readonly ModelInfo[] | undefined, settings: ModelSettings | undefined): string {
  if (!ref) return `Default (${models?.find((model) => model.ref === settings?.defaultModel)?.name ?? 'not chosen yet'})`
  const model = models?.find((each) => each.ref === ref)
  return model ? model.name : models ? `${ref} (not available)` : ref
}

/**
 * A bot's model to choose, as the web's select: "Default (…)" follows the default model, then every connected model by
 * provider; a model whose provider went away shows as not available. `saving` is the ref being saved (null: Default).
 */
export function BotModelList({ value, saving, onChoose }: { value: string | null; saving?: string | null; onChoose: (ref: string | null) => void }) {
  const { url } = useInstance()
  const loaded = useBotModels()
  const [models, settings] = loaded.data ?? []
  const providers = [...new Set(models?.map((model) => model.provider))]
  const busy = saving !== undefined
  return (
    <GroupedScroll>
      {loaded.error && !loaded.data && <Note tone="error">{`Couldn't load models: ${loaded.error}`}</Note>}
      {!loaded.data && !loaded.error && <Loading />}
      {models && (
        <Group note="Following the default, it moves to whichever model you make the default.">
          <Row label={botModelLabel(null, models, settings)} checked={value === null} busy={saving === null} disabled={busy} onPress={() => onChoose(null)} />
        </Group>
      )}
      {models && value && !models.some((model) => model.ref === value) && (
        <Group>
          <Row label={value} detail="Not available: its provider isn't connected" checked disabled />
        </Group>
      )}
      {providers.map((provider) => (
        <Group key={provider} label={provider}>
          {models
            ?.filter((model) => model.provider === provider)
            .map((model) => (
              <Row key={model.ref} label={model.name} checked={model.ref === value} busy={saving === model.ref} disabled={busy} onPress={() => onChoose(model.ref)} />
            ))}
        </Group>
      ))}
      {models?.length === 0 && (
        <Group note="Models come from connected providers, which you connect in the browser.">
          <Row label="Connect a provider" tone="link" external onPress={() => openOnWeb(url, '/settings/providers')} />
        </Group>
      )}
    </GroupedScroll>
  )
}
