import { router, Stack } from 'expo-router'
import { BotModelList } from '../../components/bot-model-list.tsx'
import { useNewBot } from '../../lib/new-bot-form.ts'

/** The new bot's model, pushed in the New bot sheet: a tap picks it and goes back. */
export default function NewBotModel() {
  const { draft, change } = useNewBot()
  return (
    <>
      <Stack.Screen options={{ title: 'Model' }} />
      <BotModelList
        value={draft.model}
        onChoose={(model) => {
          change({ model })
          router.back()
        }}
      />
    </>
  )
}
