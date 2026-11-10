import { type BotInfo, maxBotNameLength, maxBotTitleLength } from '@openbot/api-contract'
import { accessPlugins, deleteWarnings, useLive } from '@openbot/client'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { type ReactNode, useCallback, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { AvatarPicker } from '../../../components/avatar-picker.tsx'
import { BotAvatar } from '../../../components/avatar.tsx'
import { botModelLabel, useBotModels } from '../../../components/bot-model-list.tsx'
import { FieldRow, Group, GroupedScroll, Loading, Note, Row } from '../../../components/grouped.tsx'
import { ClockIcon, KeyIcon, MemoryIcon, ScreenIcon } from '../../../components/icons.tsx'
import { statusNote, useBotSave, useBotText } from '../../../lib/bot-save.ts'
import { errorMessage } from '../../../lib/errors.ts'
import { useInstance } from '../../../lib/instance-context.ts'
import { openOnWeb } from '../../../lib/open-on-web.ts'
import { openBot } from '../../../lib/routes.ts'
import { useColors } from '../../../lib/theme.ts'
import { useLoadOnFocus } from '../../../lib/use-load.ts'
import { useWhenDone } from '../../../lib/when-done.ts'

/**
 * A bot's info screen, pushed by tapping its chat's header (spec: Phone screen map), the web's Profile pane and the
 * way to its other panes: the avatar (editable), name and title, quick buttons (Screen, Routines, Memory, Access), Name
 * and Title saved as typed, Instructions and Model pushed, rows for Routines, Memory, Access and Activity, then Delete.
 */
export default function BotInfoScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const live = useLive()
  const colors = useColors()
  const bot = live.bots?.find((each) => each.id === botId)
  if (!bot) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <GroupedScroll>{live.bots ? <Note>{"This bot doesn't exist any more."}</Note> : <Loading />}</GroupedScroll>
      </>
    )
  }
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Info bot={bot} />
    </View>
  )
}

function Info({ bot }: { bot: BotInfo }) {
  const live = useLive()
  const { api, url } = useInstance()
  const colors = useColors()
  const { status, save } = useBotSave(bot.id)
  const name = useBotText(bot, 'name', save)
  const title = useBotText(bot, 'title', save)
  const [editingAvatar, setEditingAvatar] = useState(false)
  const models = useBotModels()
  const [modelList, settings] = models.data ?? []
  const botId = bot.id
  const counts = useLoadOnFocus(
    useCallback(async () => {
      const [routines, memory, plugins] = await Promise.all([api.routines.list({ botId }), api.bots.memory({ botId }), api.plugins.list()])
      const granted = accessPlugins(plugins).grantable.reduce(
        (sum, plugin) => sum + plugin.accounts.filter((account) => account.grantedTo.includes(botId)).length + (plugin.grantedTo.includes(botId) ? 1 : 0),
        0,
      )
      return { routines: routines.length, memory: memory.length, granted }
    }, [api, botId]),
  )
  // What the bot remembers changes as it works: counted again once it's done.
  const { reload } = counts
  useWhenDone(bot.working, reload)

  // The phone's Screen comes with #114; until then it's the bot's page on the web, where the Screen is.
  const openScreen = () => openOnWeb(url, `/bots/${encodeURIComponent(bot.id)}`)

  const confirmDelete = () =>
    Alert.alert(`Delete ${bot.name}?`, deleteWarnings.bot(bot.name), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          void api.bots
            .delete({ botId: bot.id })
            .then(() => {
              router.dismissTo('/')
              live.removeBot(bot.id, bot.chatId)
            })
            .catch((caught) => Alert.alert("Couldn't delete it", errorMessage(caught))),
      },
    ])

  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const counted = counts.data
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <GroupedScroll>
        <View style={styles.hero}>
          <Pressable accessibilityRole="button" accessibilityLabel="Edit avatar" onPress={() => setEditingAvatar((open) => !open)}>
            <BotAvatar bot={bot} size={84} working={bot.working} />
          </Pressable>
          <Text style={[styles.name, { color: colors.foreground }]}>{bot.name}</Text>
          {!!(bot.working || bot.title) && (
            <Text style={[styles.title, { color: bot.working ? colors.greenForeground : colors.mutedForeground }]}>{bot.working ? 'Working' : bot.title}</Text>
          )}
          <Text accessibilityRole="button" onPress={() => setEditingAvatar((open) => !open)} style={[styles.editAvatar, { color: colors.link }]}>
            {editingAvatar ? 'Done' : 'Edit avatar'}
          </Text>
        </View>
        {editingAvatar && (
          <Group>
            <AvatarPicker look={bot} onChange={save} />
          </Group>
        )}
        <View style={styles.quick}>
          <QuickButton label="Screen" icon={<ScreenIcon color={colors.foreground} />} onPress={openScreen} />
          <QuickButton label="Routines" icon={<ClockIcon size={22} color={colors.foreground} />} onPress={() => openBot(bot.id, 'routines')} />
          <QuickButton label="Memory" icon={<MemoryIcon color={colors.foreground} />} onPress={() => openBot(bot.id, 'memory')} />
          <QuickButton label="Access" icon={<KeyIcon color={colors.foreground} />} onPress={() => openBot(bot.id, 'access')} />
        </View>
        <Group label="Profile" note={statusNote(status, 'Changes save as you type.')}>
          <FieldRow
            label="Name"
            value={name.text}
            onChangeText={name.change}
            onEndEditing={name.leave}
            maxLength={maxBotNameLength}
            autoCorrect={false}
            returnKeyType="done"
          />
          <FieldRow
            label="Title"
            value={title.text}
            onChangeText={title.change}
            onEndEditing={title.leave}
            maxLength={maxBotTitleLength}
            placeholder="Describe what your bot does"
            returnKeyType="done"
          />
          <Row label="Instructions" value={bot.instructions.split('\n')[0] || 'None'} onPress={() => openBot(bot.id, 'instructions')} />
          <Row label="Model" value={botModelLabel(bot.model, modelList, settings)} onPress={() => openBot(bot.id, 'model')} />
        </Group>
        <Group note={counts.error && !counted ? `Couldn't load everything: ${counts.error}` : undefined}>
          <Row label="Routines" value={counted && String(counted.routines)} onPress={() => openBot(bot.id, 'routines')} />
          <Row label="Memory" value={counted && plural(counted.memory, 'fact', 'facts')} onPress={() => openBot(bot.id, 'memory')} />
          <Row label="Access" value={counted && plural(counted.granted, 'grant', 'grants')} onPress={() => openBot(bot.id, 'access')} />
          <Row label="Activity" onPress={() => openBot(bot.id, 'activity')} />
        </Group>
        <Group>
          <Row label={`Delete ${bot.name}`} tone="danger" onPress={confirmDelete} />
        </Group>
      </GroupedScroll>
    </>
  )
}

function QuickButton({ label, icon, onPress }: { label: string; icon: ReactNode; onPress: () => void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.quickButton, { backgroundColor: pressed ? colors.selected : colors.muted }]}
    >
      {icon}
      <Text style={[styles.quickLabel, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  hero: { alignItems: 'center', gap: 4 },
  name: { fontSize: 22, fontWeight: '600', marginTop: 8 },
  title: { fontSize: 15 },
  editAvatar: { fontSize: 15, marginTop: 4, padding: 4 },
  quick: { flexDirection: 'row', gap: 8 },
  quickButton: { flex: 1, borderRadius: 12, paddingTop: 10, paddingBottom: 8, alignItems: 'center', gap: 4 },
  quickLabel: { fontSize: 12 },
})
