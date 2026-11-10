import { isMuted } from '@openbot/api-contract'
import { membersOf, relativeTime, type RowLine, rowLine, rowStatus, type SidebarRow, useLive } from '@openbot/client'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useColors } from '../lib/theme.ts'
import { BotAvatar, GroupAvatar } from './avatar.tsx'
import { CheckIcon, MutedIcon, PinIcon } from './icons.tsx'

/** Every row is this tall, so a pinned row being dragged knows where it is. */
export const rowHeight = 68

/** A row's name: its bot's, or the group's. */
export const rowName = (row: SidebarRow) => row.bot?.name ?? row.chat?.name ?? ''

/**
 * A chat in the Chats list, as the web's sidebar row: the avatar (moving to working while the bot runs), the name with
 * pinned and muted marks, the second line (draft, waiting, working, latest message), the time and the status dot. In
 * Edit mode it has a selection circle, and `handle` (a pinned row's reorder handle) on the right.
 */
export function ChatRow({
  row,
  now,
  editing,
  selected,
  handle,
  onPress,
  onLongPress,
}: {
  row: SidebarRow
  now: number
  editing: boolean
  selected: boolean
  handle?: ReactNode
  onPress: () => void
  onLongPress?: () => void
}) {
  const live = useLive()
  const colors = useColors()
  const { bot, chat, pinned } = row
  const members = chat && !bot ? membersOf(chat, live.bots) : []
  const speaking = members.find((member) => member.id === chat?.speaking)
  const line = rowLine(row, speaking, live.drafts.get(row.chatId))
  const working = bot ? bot.working : !!speaking
  const status = rowStatus(chat)
  const needsYou = status === 'attention'
  const tone: Record<RowLine['tone'], string> = { muted: colors.mutedForeground, working: colors.greenForeground, error: colors.redForeground }
  const labelTone = line.label?.tone === 'draft' ? colors.redForeground : colors.amberForeground
  const statusLabel = status === 'attention' ? 'Needs attention' : status === 'unread' ? 'Unread activity' : undefined

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[rowName(row), statusLabel, line.label ? line.label.text + line.text : line.text].filter(Boolean).join(', ')}
      accessibilityState={editing ? { selected } : undefined}
      onPress={onPress}
      onLongPress={editing ? undefined : onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, (pressed || (editing && selected)) && { backgroundColor: colors.selected }]}
    >
      {editing && (
        <View style={[styles.check, selected ? { backgroundColor: colors.primary, borderColor: colors.primary } : { borderColor: colors.input }]}>
          {selected && <CheckIcon color={colors.primaryForeground} />}
        </View>
      )}
      {bot ? <BotAvatar bot={bot} working={working && !needsYou} waiting={needsYou} /> : <GroupAvatar members={members} working={working && !needsYou} />}
      <View style={styles.main}>
        <View style={styles.nameLine}>
          <Text numberOfLines={1} style={[styles.name, { color: colors.foreground, fontWeight: chat?.unread ? '700' : '600' }]}>
            {rowName(row)}
          </Text>
          {pinned && <PinIcon color={colors.mutedForeground} />}
          {/* Not on hidden rows: the Hidden section says they're muted. */}
          {chat && !chat.hidden && isMuted(chat, now) && <MutedIcon color={colors.mutedForeground} />}
        </View>
        <Text numberOfLines={1} style={[styles.line, { color: tone[line.tone] }]}>
          {line.label ? <Text style={{ color: labelTone }}>{line.label.text}</Text> : null}
          {line.text}
        </Text>
      </View>
      {handle ?? (
        <View style={styles.meta}>
          <Text style={[styles.time, { color: colors.mutedForeground }]}>{chat?.lastMessage ? relativeTime(chat.lastMessage.createdAt, now) : ''}</Text>
          {/* Mounted afresh when it changes: Android drew a dot whose colour changed in place as a square. */}
          {status ? (
            <View key={status} style={[styles.dot, { backgroundColor: status === 'attention' ? colors.statusAttention : colors.statusUnread }]} />
          ) : (
            <View style={styles.dot} />
          )}
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { height: rowHeight, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0, gap: 2 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  name: { fontSize: 16, flexShrink: 1 },
  line: { fontSize: 14, lineHeight: 19 },
  meta: { alignSelf: 'stretch', alignItems: 'flex-end', justifyContent: 'center', gap: 6 },
  time: { fontSize: 12, fontVariant: ['tabular-nums'] },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
})
