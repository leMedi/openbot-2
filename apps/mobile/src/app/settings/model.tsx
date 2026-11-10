import type { ModelSettings } from '@openbot/api-contract'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { Group, GroupedScroll, Loading, Note, Row } from '../../components/grouped.tsx'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { useLoadOnFocus } from '../../lib/use-load.ts'

/**
 * Settings → Models → a model to choose, by provider, as the web's select: the default model from every connected model
 * (or none), the computer-use model from those that see images (or "Same as each bot's"). A tap saves it and goes back.
 */
export default function ChooseModel() {
  const { role } = useLocalSearchParams<{ role: 'default' | 'computerUse' }>()
  const { api } = useInstance()
  const loaded = useLoadOnFocus(useCallback(() => Promise.all([api.models.list(), api.models.getSettings()]), [api]))
  const [saving, setSaving] = useState<string | null>()
  const key: keyof ModelSettings = role === 'computerUse' ? 'computerUseModel' : 'defaultModel'
  const [all, settings] = loaded.data ?? []
  const models = role === 'computerUse' ? all?.filter((model) => model.vision) : all
  const current = settings?.[key] ?? null

  const choose = async (ref: string | null) => {
    if (ref === current) return router.back()
    setSaving(ref)
    try {
      await api.models.updateSettings({ [key]: ref })
      router.back()
    } catch (caught) {
      setSaving(undefined)
      Alert.alert("Couldn't change the model", errorMessage(caught))
    }
  }

  const providers = [...new Set(models?.map((model) => model.provider))]
  const busy = saving !== undefined
  return (
    <>
      <Stack.Screen options={{ title: role === 'computerUse' ? 'Computer-use model' : 'Default model' }} />
      <GroupedScroll>
        {loaded.error && !loaded.data && <Note tone="error">{`Couldn't load models: ${loaded.error}`}</Note>}
        {!loaded.data && !loaded.error && <Loading />}
        {models && (
          <Group note={role === 'computerUse' ? 'Each bot drives its screen with its own model, or the default.' : 'Bots without a model of their own then have none to run on.'}>
            <Row
              label={role === 'computerUse' ? "Same as each bot's model" : 'No default model'}
              checked={current === null}
              busy={saving === null}
              disabled={busy}
              onPress={() => void choose(null)}
            />
          </Group>
        )}
        {/* A chosen model whose provider was since disconnected. */}
        {models && current && !models.some((model) => model.ref === current) && (
          <Group>
            <Row label={current} detail="Not available: its provider isn't connected" checked disabled />
          </Group>
        )}
        {providers.map((provider) => (
          <Group key={provider} label={provider}>
            {models
              ?.filter((model) => model.provider === provider)
              .map((model) => (
                <Row
                  key={model.ref}
                  label={model.name}
                  checked={model.ref === current}
                  busy={saving === model.ref}
                  disabled={busy}
                  onPress={() => void choose(model.ref)}
                />
              ))}
          </Group>
        ))}
        {models?.length === 0 && <Note>{role === 'computerUse' ? 'No connected model can see images.' : 'Connect a provider to choose models.'}</Note>}
      </GroupedScroll>
    </>
  )
}
