import { randomAvatar } from '@openbot/client'
import { Stack } from 'expo-router'
import { useState } from 'react'
import { NewBotContext, type NewBotDraft } from '../../lib/new-bot-form.ts'
import { useColors } from '../../lib/theme.ts'

/** The New bot sheet's own stack (spec: Phone screen map): the form, then the model pushed within the sheet. */
export default function NewBotLayout() {
  const colors = useColors()
  const [draft, setDraft] = useState<NewBotDraft>(() => ({ name: '', title: '', instructions: '', model: null, ...randomAvatar() }))
  return (
    <NewBotContext value={{ draft, change: (changes) => setDraft((current) => ({ ...current, ...changes })) }}>
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTitleAlign: 'center',
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.foreground,
          headerTitleStyle: { color: colors.foreground },
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </NewBotContext>
  )
}
