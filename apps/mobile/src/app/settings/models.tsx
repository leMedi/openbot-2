import type { ModelInfo } from '@openbot/api-contract'
import { router, Stack } from 'expo-router'
import { useCallback } from 'react'
import { Group, GroupedScroll, Loading, Note, Row } from '../../components/grouped.tsx'
import { useInstance } from '../../lib/instance-context.ts'
import { openOnWeb } from '../../lib/open-on-web.ts'
import { useLoadOnFocus } from '../../lib/use-load.ts'

/** A model ref as a row shows it: its name, or the ref itself once its provider was disconnected. */
function modelName(models: readonly ModelInfo[], ref: string): string {
  const model = models.find((each) => each.ref === ref)
  return model ? model.name : `${ref} (not available)`
}

/**
 * Settings → Models, as the web's: the default model and the computer-use model, each chosen on a pushed list of the
 * connected providers' models.
 */
export default function Models() {
  const { api, url } = useInstance()
  const loaded = useLoadOnFocus(useCallback(() => Promise.all([api.models.list(), api.models.getSettings()]), [api]))
  const [models, settings] = loaded.data ?? []
  const defaultModel = models?.find((model) => model.ref === settings?.defaultModel)

  return (
    <>
      <Stack.Screen options={{ title: 'Models' }} />
      <GroupedScroll>
        {loaded.error && !loaded.data && <Note tone="error">{`Couldn't load models: ${loaded.error}`}</Note>}
        {!loaded.data && !loaded.error && <Loading />}
        {models?.length === 0 && (
          <Group note="Models come from connected providers, which you connect in the browser.">
            <Row label="Connect a provider" tone="link" external onPress={() => openOnWeb(url, '/settings/providers')} />
          </Group>
        )}
        {models && settings && models.length > 0 && (
          <>
            <Group note="Every bot uses this model unless it has its own.">
              <Row
                label="Default model"
                value={settings.defaultModel ? modelName(models, settings.defaultModel) : 'Choose a model'}
                onPress={() => router.push({ pathname: '/settings/model', params: { role: 'default' } })}
              />
            </Group>
            <Group
              note={
                !settings.computerUseModel && defaultModel && !defaultModel.vision
                  ? `${defaultModel.name} can't see images: bots on it work their screens from snapshots alone. Choose a computer-use model so they can see screenshots.`
                  : "Drives bots' screens, so it must understand images."
              }
            >
              <Row
                label="Computer-use model"
                value={settings.computerUseModel ? modelName(models, settings.computerUseModel) : "Same as each bot's"}
                onPress={() => router.push({ pathname: '/settings/model', params: { role: 'computerUse' } })}
              />
            </Group>
          </>
        )}
      </GroupedScroll>
    </>
  )
}
