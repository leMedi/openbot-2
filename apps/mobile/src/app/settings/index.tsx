import { useLive } from '@openbot/client'
import Constants from 'expo-constants'
import { router, Stack } from 'expo-router'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { Group, GroupedScroll, Row } from '../../components/grouped.tsx'
import { shownAddress } from '../../lib/connect/address.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { openOnWeb } from '../../lib/open-on-web.ts'
import { useColors } from '../../lib/theme.ts'

/**
 * The Settings sheet (spec: Phone screen map, Connect flow): the instance (its address, Edit address, Disconnect),
 * then General, Models, Plugins and Shared memory pushed in the sheet, This phone, and Providers, which open the
 * instance in the browser, as signing in to a provider stays on the web.
 */
export default function Settings() {
  const { url, disconnect } = useInstance()
  const live = useLive()
  const colors = useColors()

  const confirmDisconnect = () =>
    Alert.alert(
      'Disconnect from OpenBot?',
      `This phone forgets ${shownAddress(url)}: its chats, drafts and notifications here. Nothing changes on your computer, and you can connect again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            // Closed first, so connecting again opens on Chats rather than on this sheet.
            router.dismissTo('/')
            disconnect()
          },
        },
      ],
    )

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Settings',
          headerRight: () => (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => router.back()} style={styles.done}>
              <Text style={[styles.doneLabel, { color: colors.foreground }]}>Done</Text>
            </Pressable>
          ),
        }}
      />
      <GroupedScroll>
        <Group label="Instance">
          <Row
            label={shownAddress(url)}
            detail={live.connected ? 'Connected' : "Can't reach it right now"}
            icon={<View style={[styles.dot, { backgroundColor: live.connected ? colors.statusWorking : colors.statusOffline }]} />}
          />
          <Row label="Edit address" onPress={() => router.push('/settings/edit-address')} />
          <Row label="Disconnect" tone="danger" onPress={confirmDisconnect} />
        </Group>
        <Group>
          <Row label="General" onPress={() => router.push('/settings/general')} />
          <Row label="Models" onPress={() => router.push('/settings/models')} />
          <Row label="Plugins" onPress={() => router.push('/settings/plugins')} />
          <Row label="Shared memory" onPress={() => router.push('/settings/shared-memory')} />
        </Group>
        {/* Filled by Notifications on the phone (#116) and Dictation on the phone (#115). */}
        <Group label="This phone">
          <Row label="Notifications" value="Coming soon" disabled />
          <Row label="Dictation" value="Coming soon" disabled />
        </Group>
        <Group label="On the web" note="Signing in to a provider happens in the browser.">
          <Row label="Providers" tone="link" external onPress={() => openOnWeb(url, '/settings/providers')} />
        </Group>
        <Text style={[styles.version, { color: colors.faint }]}>OpenBot app {Constants.expoConfig?.version}</Text>
      </GroupedScroll>
    </>
  )
}

const styles = StyleSheet.create({
  done: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 6 },
  doneLabel: { fontSize: 17, fontWeight: '600' },
  dot: { width: 9, height: 9, borderRadius: 5 },
  version: { fontSize: 12, textAlign: 'center' },
})
