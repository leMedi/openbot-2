import { Stack, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Linking } from 'react-native'
import { Group, GroupedScroll, Note, Row, SwitchRow } from '../../components/grouped.tsx'
import { useInstance } from '../../lib/instance-context.ts'
import { useNotifications } from '../../lib/notifications/use-notifications.ts'

/**
 * Settings → This phone → Notifications (spec: Notifications): on or off for this phone, which registers it with the
 * instance or unregisters it, then Messages and When a bot needs you, stored with this phone on the instance; and
 * Open Settings when the phone doesn't allow OpenBot to notify.
 */
export default function NotificationSettings() {
  const { notifications } = useInstance()
  const { permission, device, error } = useNotifications()
  const [busy, setBusy] = useState(false)
  // Read again each time: the owner may have removed this phone on the web, or changed the permission.
  useFocusEffect(useCallback(() => void notifications.refresh().catch(() => {}), [notifications]))

  const blocked = permission?.status === 'denied'
  const turn = async (on: boolean) => {
    setBusy(true)
    try {
      if (!on) return await notifications.turnOff()
      if ((await notifications.turnOn()) === 'denied') {
        Alert.alert('Notifications are off for OpenBot', "Allow them in your phone's settings, then turn them on here.", [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ])
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Notifications' }} />
      <GroupedScroll>
        {blocked && (
          <Group note="Your phone doesn't let OpenBot notify you. Allow notifications for OpenBot in its settings.">
            <Row label="Open Settings" tone="link" external onPress={() => void Linking.openSettings()} />
          </Group>
        )}
        <Group note="Your OpenBot sends notifications to this phone. Turning them off here stops them for this phone only.">
          <SwitchRow label="Notifications" value={!!device} onChange={(on) => void turn(on)} disabled={busy || !permission} />
        </Group>
        {device && (
          <Group
            label="Notify me about"
            note="Messages: a bot posting in a chat. When a bot needs you: a question, a take-over, a plugin request. Muted chats only notify when a bot needs you."
          >
            <SwitchRow label="Messages" value={device.messages} onChange={(messages) => void notifications.setSwitches({ messages })} />
            <SwitchRow label="When a bot needs you" value={device.needsYou} onChange={(needsYou) => void notifications.setSwitches({ needsYou })} />
          </Group>
        )}
        {error && <Note tone="error">{error}</Note>}
      </GroupedScroll>
    </>
  )
}
