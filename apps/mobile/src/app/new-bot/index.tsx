import { maxBotInstructionsLength, maxBotNameLength, maxBotTitleLength } from '@openbot/api-contract'
import { useLive } from '@openbot/client'
import { router, Stack } from 'expo-router'
import { useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { AvatarPicker } from '../../components/avatar-picker.tsx'
import { BotAvatar } from '../../components/avatar.tsx'
import { botModelLabel, useBotModels } from '../../components/bot-model-list.tsx'
import { FieldRow, Group, GroupedScroll, Row } from '../../components/grouped.tsx'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { useNewBot } from '../../lib/new-bot-form.ts'
import { SheetHeaderButton } from '../../components/sheet-header-button.tsx'
import { useColors } from '../../lib/theme.ts'

/**
 * The New bot sheet (spec: Phone screen map), as the web's form: the avatar (style, shape, color), Name, Title,
 * Instructions and Model. Create makes the bot and lands in its new chat.
 */
export default function NewBot() {
  const { draft, change } = useNewBot()
  const { api } = useInstance()
  const live = useLive()
  const colors = useColors()
  const models = useBotModels()
  const [modelList, settings] = models.data ?? []
  const [creating, setCreating] = useState(false)
  const [editingAvatar, setEditingAvatar] = useState(false)
  const canCreate = !!draft.name.trim() && !creating

  const create = async () => {
    setCreating(true)
    try {
      const bot = await api.bots.create({
        name: draft.name.trim(),
        title: draft.title.trim() || null,
        instructions: draft.instructions,
        avatarStyle: draft.avatarStyle,
        avatarShape: draft.avatarShape,
        avatarColor: draft.avatarColor,
        model: draft.model,
      })
      live.addBot(bot)
      // Closed first, so the chat is pushed on the app's stack, not the sheet's.
      router.dismissTo('/')
      router.push({ pathname: '/chat/[chatId]', params: { chatId: bot.chatId } })
    } catch (caught) {
      setCreating(false)
      Alert.alert("Couldn't create the bot", errorMessage(caught))
    }
  }


  return (
    <>
      <Stack.Screen
        options={{
          title: 'New bot',
          headerLeft: () => <SheetHeaderButton label="Cancel" onPress={() => router.back()} />,
          headerRight: () => <SheetHeaderButton label="Create" onPress={() => void create()} enabled={canCreate} strong />,
        }}
      />
      <GroupedScroll>
        <View style={styles.hero}>
          <Pressable accessibilityRole="button" accessibilityLabel="Edit avatar" onPress={() => setEditingAvatar((open) => !open)}>
            <BotAvatar bot={draft} size={84} />
          </Pressable>
          <Text accessibilityRole="button" onPress={() => setEditingAvatar((open) => !open)} style={[styles.editAvatar, { color: colors.link }]}>
            {editingAvatar ? 'Done' : 'Edit avatar'}
          </Text>
        </View>
        {editingAvatar && (
          <Group>
            <AvatarPicker look={draft} onChange={change} />
          </Group>
        )}
        <Group note="How you and other bots mention it; no two bots share one.">
          <FieldRow label="Name" value={draft.name} onChangeText={(name) => change({ name })} placeholder="Rex" maxLength={maxBotNameLength} autoCorrect={false} autoFocus returnKeyType="next" />
          <FieldRow label="Title" value={draft.title} onChangeText={(title) => change({ title })} placeholder="Describe what your bot does" maxLength={maxBotTitleLength} returnKeyType="done" />
        </Group>
        <Group label="Instructions" note="Who the bot is and how it behaves.">
          <FieldRow
            accessibilityLabel="Instructions"
            value={draft.instructions}
            onChangeText={(instructions) => change({ instructions })}
            placeholder="A calm release engineer who fixes builds and explains what went wrong in plain words."
            maxLength={maxBotInstructionsLength}
            multiline
          />
        </Group>
        <Group>
          <Row label="Model" value={botModelLabel(draft.model, modelList, settings)} onPress={() => router.push('/new-bot/model')} />
        </Group>
      </GroupedScroll>
    </>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 4 },
  editAvatar: { fontSize: 15, marginTop: 4, padding: 4 },
})
