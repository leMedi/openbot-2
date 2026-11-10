import { previewText, type BotInfo, type ChatInfo } from '@openbot/api-contract'
import { sidebarLayout, useLive } from '@openbot/client'
import { Stack } from 'expo-router'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { radii, text, useColors } from '../lib/theme.ts'

/**
 * The chats, in the sidebar's order (pinned, sections, then Hidden), live from the instance. A first cut that proves
 * the app talks to an instance; the Chats list's own work makes it the real home screen.
 */
export default function Chats() {
  const live = useLive()
  const colors = useColors()
  const rows = live.bots ? sidebarLayout(live.bots, live.chats, live.sections, {}).blocks.flatMap((block) => block.rows) : []
  return (
    <>
      <Stack.Screen options={{ title: 'Chats', headerLargeTitle: true, headerLargeTitleShadowVisible: false }} />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.background }}
        data={rows}
        keyExtractor={(row) => row.chatId}
        ListHeaderComponent={
          live.connected ? undefined : (
            <Text style={[text.base, styles.status, { color: colors.mutedForeground }]}>{live.bots ? 'Reconnecting…' : 'Connecting…'}</Text>
          )
        }
        renderItem={({ item }) => <ChatRow bot={item.bot} chat={item.chat} />}
      />
    </>
  )
}

function ChatRow({ bot, chat }: { bot: BotInfo | undefined; chat: ChatInfo | undefined }) {
  const colors = useColors()
  const working = bot ? bot.working : !!chat?.speaking
  const dot = chat?.waitingFor ? colors.statusAttention : working ? colors.statusWorking : chat?.unread ? colors.statusUnread : undefined
  const last = chat?.lastMessage
  const line = chat?.waitingFor
    ? `Waiting for you: ${previewText(chat.waitingFor)}`
    : working
      ? 'Working…'
      : last
        ? previewText(last.text) || (last.attachments.length ? 'Attachment' : '')
        : (bot?.title ?? 'No messages yet')
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text numberOfLines={1} style={[text.lg, styles.name, { color: colors.foreground }]}>
          {bot?.name ?? chat?.name ?? 'Group chat'}
        </Text>
        <Text numberOfLines={1} style={[text.base, { color: colors.mutedForeground }]}>
          {line}
        </Text>
      </View>
      {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  status: { paddingHorizontal: 16, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  text: { flex: 1, gap: 2 },
  name: { fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: radii.sm },
})
