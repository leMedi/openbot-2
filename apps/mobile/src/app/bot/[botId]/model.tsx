import { useLive } from '@openbot/client'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { Alert } from 'react-native'
import { BotModelList } from '../../../components/bot-model-list.tsx'
import { GroupedScroll, Loading, Note } from '../../../components/grouped.tsx'
import { errorMessage } from '../../../lib/errors.ts'
import { useInstance } from '../../../lib/instance-context.ts'

/** A bot's model, pushed from its info screen: a tap saves it and goes back. */
export default function BotModel() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const live = useLive()
  const { api } = useInstance()
  const bot = live.bots?.find((each) => each.id === botId)
  const [saving, setSaving] = useState<string | null>()

  const choose = async (ref: string | null) => {
    if (!bot || ref === bot.model) return router.back()
    setSaving(ref)
    try {
      live.updateBot(await api.bots.update({ botId, model: ref }))
      router.back()
    } catch (caught) {
      setSaving(undefined)
      Alert.alert("Couldn't change the model", errorMessage(caught))
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Model' }} />
      {bot ? (
        <BotModelList value={bot.model} saving={saving} onChoose={(ref) => void choose(ref)} />
      ) : (
        <GroupedScroll>{live.bots ? <Note>{"This bot doesn't exist any more."}</Note> : <Loading />}</GroupedScroll>
      )}
    </>
  )
}
