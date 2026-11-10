import { type BotInfo, maxGroupMembers, minGroupMembers } from '@openbot/api-contract'
import { nameMatches, useLive } from '@openbot/client'
import { router, Stack } from 'expo-router'
import { useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { BotAvatar } from '../../components/avatar.tsx'
import { CheckIcon } from '../../components/icons.tsx'
import { SheetHeaderButton } from '../../components/sheet-header-button.tsx'
import { useColors } from '../../lib/theme.ts'

/**
 * The New group chat sheet (spec: Phone screen map): a "To:" field of the chosen bots as chips, typing filtering the
 * bots below, each ticked on or off. Create closes it and pushes the group chat, whose first message creates it, as on
 * the web.
 */
export default function NewGroup() {
  const live = useLive()
  const colors = useColors()
  const [members, setMembers] = useState<BotInfo[]>([])
  const [query, setQuery] = useState('')
  const shown = (live.bots ?? []).filter((bot) => nameMatches(bot, query))
  const full = members.length >= maxGroupMembers
  const enough = members.length >= minGroupMembers

  const toggle = (bot: BotInfo) => {
    if (members.some((member) => member.id === bot.id)) setMembers(members.filter((member) => member.id !== bot.id))
    else if (!full) {
      setMembers([...members, bot])
      setQuery('')
    }
  }
  const create = () => {
    router.dismissTo('/')
    router.push({ pathname: '/new-group-chat', params: { members: members.map((bot) => bot.id).join(',') } })
  }


  return (
    <>
      <Stack.Screen
        options={{
          title: 'New group chat',
          headerLeft: () => <SheetHeaderButton label="Cancel" onPress={() => router.back()} />,
          headerRight: () => <SheetHeaderButton label="Create" onPress={create} enabled={enough} strong />,
        }}
      />
      <View style={[styles.to, { borderBottomColor: colors.border }]}>
        <Text style={[styles.toLabel, { color: colors.mutedForeground }]}>To:</Text>
        {members.map((bot) => (
          <Pressable
            key={bot.id}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${bot.name}`}
            onPress={() => toggle(bot)}
            style={[styles.chip, { backgroundColor: colors.blueSubtle }]}
          >
            <Text style={[styles.chipText, { color: colors.blueForeground }]}>{bot.name}</Text>
          </Pressable>
        ))}
        <TextInput
          accessibilityLabel="To"
          value={query}
          onChangeText={setQuery}
          onKeyPress={({ nativeEvent }) => nativeEvent.key === 'Backspace' && !query && members.length && setMembers(members.slice(0, -1))}
          placeholder={full ? `Up to ${maxGroupMembers} members` : members.length ? '' : 'Type a bot’s name'}
          placeholderTextColor={colors.faint}
          editable={!full}
          autoCorrect={false}
          autoCapitalize="none"
          style={[styles.toField, { color: colors.foreground }]}
        />
      </View>
      <FlatList
        data={shown}
        keyExtractor={(bot) => bot.id}
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: colors.background }}
        renderItem={({ item: bot }) => {
          const chosen = members.some((member) => member.id === bot.id)
          const disabled = !chosen && full
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: chosen, disabled }}
              disabled={disabled}
              onPress={() => toggle(bot)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.selected }, disabled && { opacity: 0.4 }]}
            >
              <View style={[styles.check, chosen ? { backgroundColor: colors.primary, borderColor: colors.primary } : { borderColor: colors.input }]}>
                {chosen && <CheckIcon color={colors.primaryForeground} />}
              </View>
              <BotAvatar bot={bot} size={36} />
              <View style={styles.main}>
                <Text numberOfLines={1} style={[styles.name, { color: colors.foreground }]}>
                  {bot.name}
                </Text>
                {!!bot.title && (
                  <Text numberOfLines={1} style={[styles.title, { color: colors.mutedForeground }]}>
                    {bot.title}
                  </Text>
                )}
              </View>
            </Pressable>
          )
        }}
        ListEmptyComponent={
          <Text style={[styles.note, { color: colors.mutedForeground }]}>{live.bots?.length ? 'No bot has that name.' : 'Create bots first, then group them here.'}</Text>
        }
        ListFooterComponent={
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            {`A group chat has ${minGroupMembers} to ${maxGroupMembers} bots. They answer in turns; mention @name to ask one of them.`}
          </Text>
        }
      />
    </>
  )
}

const styles = StyleSheet.create({
  to: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  toLabel: { fontSize: 16 },
  chip: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 15 },
  toField: { flex: 1, minWidth: 100, fontSize: 16, paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 9 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '600' },
  title: { fontSize: 14 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 12 },
})
