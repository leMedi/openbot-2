import { useEffect, useRef, useState } from 'react'
import { AppState, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { candidateUrls } from '../lib/connect/address.ts'
import type { CheckResult, Failure } from '../lib/connect/check.ts'
import { failureMessage } from '../lib/connect/messages.ts'
import { checkFromPhone } from '../lib/connect/phone.ts'
import { localNetworkAsked } from '../lib/saved-instance.ts'
import { radii, text, useColors } from '../lib/theme.ts'
import { Body, Button, OpenSettings } from './ui.tsx'

/** How often, and how long, Connect tries again while iOS's Local Network prompt waits for the owner. */
const permissionRetryMs = 2_000
const permissionWaitMs = 60_000

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'waitingForPermission' }
  | { kind: 'failed'; message: string; failure?: Failure }

/**
 * The first screen (spec: Connect flow): the owner types the address they open OpenBot at in their browser, and the
 * app finds the URL that answers. A result other than a failure goes to `onResult`, the field showing that URL.
 */
export function Connect({ initialAddress = '', onResult }: { initialAddress?: string; onResult: (result: Exclude<CheckResult, { kind: 'failed' }>) => void }) {
  const colors = useColors()
  const [address, setAddress] = useState(initialAddress)
  const [state, setState] = useState<State>({ kind: 'idle' })
  const attempt = useRef(0)
  useEffect(() => () => void attempt.current++, [])

  const connect = async () => {
    const candidates = candidateUrls(address)
    if (!candidates.length) return setState({ kind: 'failed', message: "That isn't an address. Type it as in your browser, e.g. 192.168.1.20:3000." })
    const mine = ++attempt.current
    setState({ kind: 'checking' })
    let result = await checkFromPhone(candidates)
    // iOS fails the first request to the local network while it asks the owner for permission: wait for the answer.
    if (result.kind === 'failed' && result.failure.kind === 'localNetwork' && !localNetworkAsked.get()) {
      localNetworkAsked.set()
      setState({ kind: 'waitingForPermission' })
      // The prompt makes the app inactive; once it's active again the owner answered, and one more try tells which.
      let answered = false
      const subscription = AppState.addEventListener('change', (next) => void (next === 'active' && (answered = true)))
      const until = Date.now() + permissionWaitMs
      try {
        while (result.kind === 'failed' && result.failure.kind === 'localNetwork' && Date.now() < until && mine === attempt.current) {
          await new Promise((resolve) => setTimeout(resolve, permissionRetryMs))
          const last = answered
          result = await checkFromPhone(candidates)
          if (last) break
        }
      } finally {
        subscription.remove()
      }
    }
    if (mine !== attempt.current) return
    if (result.kind === 'failed') return setState({ kind: 'failed', message: failureMessage(result.failure, result.url), failure: result.failure })
    setState({ kind: 'idle' })
    setAddress(result.url)
    onResult(result)
  }

  const busy = state.kind === 'checking' || state.kind === 'waitingForPermission'
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.column}>
        <Text style={[styles.mark, { color: colors.foreground }]}>OpenBot</Text>
        <View style={styles.field}>
          <TextInput
            accessibilityLabel="Address"
            value={address}
            onChangeText={(value) => {
              setAddress(value)
              if (state.kind === 'failed') setState({ kind: 'idle' })
            }}
            onSubmitEditing={() => void (busy ? undefined : connect())}
            placeholder="192.168.1.20:3000"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="url"
            keyboardType="url"
            textContentType="URL"
            returnKeyType="go"
            editable={!busy}
            style={[text.lg, styles.input, { color: colors.foreground, backgroundColor: colors.inputFill, borderColor: colors.input }]}
          />
          <Body>The address you open OpenBot at in your browser (not localhost).</Body>
        </View>
        {state.kind === 'waitingForPermission' && <Body tone="plain">Waiting for permission…</Body>}
        {state.kind === 'failed' && (
          <View accessibilityLiveRegion="polite" style={styles.error}>
            <Body tone="error">{state.message}</Body>
            {state.failure && <OpenSettings failure={state.failure} />}
          </View>
        )}
        <Button label="Connect" kind="primary" busy={busy} disabled={!address.trim()} onPress={() => void connect()} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  column: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 16, width: '100%', maxWidth: 440, alignSelf: 'center' },
  mark: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.6, marginBottom: 8 },
  field: { gap: 8 },
  input: { height: 44, borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, fontSize: 16 },
  error: { gap: 12 },
})
