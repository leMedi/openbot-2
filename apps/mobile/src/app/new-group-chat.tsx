import { minGroupMembers } from '@openbot/api-contract'
import { useLive } from '@openbot/client'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useState } from 'react'
import { KeyboardAvoidingView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GroupAvatar } from '../components/avatar.tsx'
import { Composer } from '../components/composer.tsx'
import { ConnectionBanner } from '../components/connection-banner.tsx'
import { errorMessage } from '../lib/errors.ts'
import { useInstance } from '../lib/instance-context.ts'
import { useColors } from '../lib/theme.ts'

/**
 * A group chat about to start, pushed by the New group chat sheet's Create: its members in the header, and the composer,
 * whose first message creates the group (named after its members until renamed), as the web's new group chat does.
 * The chat then takes this screen's place.
 */
export default function NewGroupChat() {
  const { members: memberIds = '' } = useLocalSearchParams<{ members?: string }>()
  const live = useLive()
  const { api } = useInstance()
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const ids = memberIds.split(',').filter(Boolean)
  const members = ids.flatMap((id) => live.bots?.find((bot) => bot.id === id) ?? [])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const names = members.map((bot) => bot.name).join(', ')

  const send = async (message: string) => {
    setSending(true)
    setError(undefined)
    try {
      const { chat, message: posted } = await api.groups.create({ memberIds: members.map((bot) => bot.id), text: message })
      live.setChat(chat)
      live.addMessage(posted)
      router.replace({ pathname: '/chat/[chatId]', params: { chatId: chat.id } })
    } catch (caught) {
      // The message comes back, to send again.
      setText(message)
      setError(errorMessage(caught))
      setSending(false)
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerBackTitle: 'Chats',
          headerTitleAlign: 'left',
          headerTransparent: true,
          headerTitle: () => (
            <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={`New group chat with ${names}`}>
              <GroupAvatar members={members} size={30} />
              <View style={styles.titleText}>
                <Text numberOfLines={1} style={[styles.name, { color: colors.foreground }]}>
                  New group chat
                </Text>
                <Text numberOfLines={1} style={[styles.subtitle, { color: colors.mutedForeground }]}>
                  {names}
                </Text>
              </View>
            </View>
          ),
        }}
      />
      <KeyboardAvoidingView behavior="padding" style={[styles.screen, { paddingTop: headerHeight, backgroundColor: colors.background }]}>
        <ConnectionBanner />
        <View style={styles.screen}>
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            {members.length >= minGroupMembers
              ? 'Send a message to start the group. Its members answer in turns; mention @name to ask one of them.'
              : `A group chat needs at least ${minGroupMembers} bots.`}
          </Text>
        </View>
        {error && <Text style={[styles.error, { color: colors.destructiveForeground }]}>{error}</Text>}
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer
            chatId="new-group"
            label={`Message ${names}`}
            files={[]}
            notice={undefined}
            canSend={live.connected && !sending && members.length >= minGroupMembers}
            onRemove={() => {}}
            onSend={(message) => void send(message)}
            draft={{ text, onText: setText }}
          />
        </View>
      </KeyboardAvoidingView>
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { textAlign: 'center', fontSize: 15, marginTop: 48, paddingHorizontal: 32 },
  error: { fontSize: 13, paddingHorizontal: 16, paddingBottom: 4 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 260 },
  titleText: { flexShrink: 1 },
  name: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 12 },
})
