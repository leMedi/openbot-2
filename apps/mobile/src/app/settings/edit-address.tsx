import { router, Stack } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Alert, StyleSheet, View } from 'react-native'
import { FieldRow, Group, GroupedScroll } from '../../components/grouped.tsx'
import { Body, Button, OpenSettings } from '../../components/ui.tsx'
import { candidateUrls, shownAddress } from '../../lib/connect/address.ts'
import { addressChange } from '../../lib/connect/change.ts'
import type { Failure } from '../../lib/connect/check.ts'
import { failureMessage } from '../../lib/connect/messages.ts'
import { checkFromPhone } from '../../lib/connect/phone.ts'
import { useInstance } from '../../lib/instance-context.ts'

type State = { kind: 'idle' } | { kind: 'checking' } | { kind: 'failed'; message: string; failure?: Failure }

/**
 * Settings → Instance → Edit address (spec: Connect flow): the new address is checked as Connect checks one. The same
 * instance there switches at once, keeping this phone's cache and drafts; another instance first warns that they'll be
 * removed. One that can't be used leaves the current address in place, saying why.
 */
export default function EditAddress() {
  const { url, instanceId, moveTo } = useInstance()
  const [address, setAddress] = useState(shownAddress(url))
  const [state, setState] = useState<State>({ kind: 'idle' })
  const attempt = useRef(0)
  useEffect(() => () => void attempt.current++, [])

  const save = async () => {
    const candidates = candidateUrls(address)
    if (!candidates.length) return setState({ kind: 'failed', message: "That isn't an address. Type it as in your browser, e.g. 192.168.1.20:3000." })
    const mine = ++attempt.current
    setState({ kind: 'checking' })
    const result = await checkFromPhone(candidates)
    if (mine !== attempt.current) return
    const change = addressChange({ url, instanceId, setUp: true }, result)
    setState({ kind: 'idle' })
    switch (change.kind) {
      case 'unchanged':
        return router.back()
      case 'sameInstance':
        // Back to Settings, now at the new address: the app's stack is built again for it on the same screens.
        router.back()
        return moveTo(change.instance, { forget: false })
      case 'otherInstance':
        setAddress(shownAddress(change.instance.url))
        return Alert.alert(
          'Switch to another OpenBot?',
          `${shownAddress(change.instance.url)} is a different OpenBot from the one this phone uses. Switching removes this phone's cached chats, drafts and notifications.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Switch',
              style: 'destructive',
              onPress: () => {
                // Chats, on the new instance.
                router.dismissTo('/')
                moveTo(change.instance, { forget: true })
              },
            },
          ],
        )
      case 'failed':
        return setState({ kind: 'failed', message: failureMessage(change.failure, change.url), failure: change.failure })
      case 'instanceTooOld':
        return setState({ kind: 'failed', message: `OpenBot at ${shownAddress(change.url)} is older than this app needs. Update OpenBot there first.` })
      case 'appTooOld':
        return setState({ kind: 'failed', message: `OpenBot at ${shownAddress(change.url)} is newer than this app. Update the app first.` })
    }
  }

  const checking = state.kind === 'checking'
  return (
    <>
      <Stack.Screen options={{ title: 'Edit address' }} />
      <GroupedScroll>
        <Group note="The address you open OpenBot at in your browser (not localhost). Your chats stay on this phone if it's the same OpenBot.">
          <FieldRow
            value={address}
            onChangeText={(value) => {
              setAddress(value)
              if (state.kind === 'failed') setState({ kind: 'idle' })
            }}
            onSubmitEditing={() => void (checking ? undefined : save())}
            accessibilityLabel="Address"
            placeholder="192.168.1.20:3000"
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="url"
            keyboardType="url"
            textContentType="URL"
            returnKeyType="go"
            editable={!checking}
            selectTextOnFocus
          />
        </Group>
        {state.kind === 'failed' && (
          <View accessibilityLiveRegion="polite" style={styles.error}>
            <Body tone="error">{state.message}</Body>
            {state.failure && <OpenSettings failure={state.failure} />}
          </View>
        )}
        <Button label="Connect" kind="primary" busy={checking} disabled={!address.trim()} onPress={() => void save()} />
      </GroupedScroll>
    </>
  )
}

const styles = StyleSheet.create({
  error: { gap: 12, paddingHorizontal: 12 },
})
