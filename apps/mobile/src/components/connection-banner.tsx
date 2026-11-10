import { useLive } from '@openbot/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { CheckResult } from '../lib/connect/check.ts'
import { failureMessage } from '../lib/connect/messages.ts'
import { checkFromPhone } from '../lib/connect/phone.ts'
import { useInstance } from '../lib/instance-context.ts'
import { radii, text, useColors } from '../lib/theme.ts'
import { Body, Button, OpenSettings, Title } from './ui.tsx'

/** How long the live stream may be down before the banner shows, so a quick reconnect doesn't flash it. */
const bannerDelayMs = 3_000

/** Whether the instance has been out of reach as long as the banner waits before showing, as it shows then. */
export function useUnreachable(): boolean {
  const live = useLive()
  return useDownFor(!live.connected, bannerDelayMs)
}

/**
 * "Can't reach OpenBot · Retrying" while the live stream is down (spec: Connect flow): after setup the app never goes
 * back to Connect. Tapping it shows the diagnosis, as Connect would word it, and Try now.
 */
export function ConnectionBanner() {
  const colors = useColors()
  const down = useUnreachable()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  if (!down && !open) return null
  return (
    <>
      {down && (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Shows why and lets you try again now"
          onPress={() => setOpen(true)}
          style={({ pressed }) => [styles.banner, { backgroundColor: colors.blueSubtle, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[text.base, { color: colors.blueForeground }]}>{"Can't reach OpenBot · Retrying"}</Text>
        </Pressable>
      )}
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
        <Diagnosis onClose={close} />
      </Modal>
    </>
  )
}

/** Whether `down` has held for `delayMs`. */
function useDownFor(down: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!down) return
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => {
      clearTimeout(timer)
      setShown(false)
    }
  }, [down, delayMs])
  return down && shown
}

/** Why the instance can't be reached, checked when opened and on Try now, which also reconnects at once. */
function Diagnosis({ onClose }: { onClose: () => void }) {
  const live = useLive()
  const { url, noteCheck } = useInstance()
  const colors = useColors()
  const [result, setResult] = useState<CheckResult>()
  const [checking, setChecking] = useState(true)
  // The latest check, so an earlier one finishing late, or one finishing once closed, is ignored.
  const latest = useRef(0)

  const check = useCallback(() => {
    const mine = ++latest.current
    void checkFromPhone([url]).then((next) => {
      if (mine !== latest.current) return
      setResult(next)
      setChecking(false)
      // A version block shows in place of the app.
      noteCheck(next)
    })
  }, [url, noteCheck])
  // Checked when opened; Try now checks again.
  useEffect(() => {
    check()
    const checks = latest
    return () => void checks.current++
  }, [check])

  // Back in touch: nothing left to diagnose.
  useEffect(() => {
    if (live.connected) onClose()
  }, [live.connected, onClose])

  const tryNow = () => {
    live.retryNow()
    setChecking(true)
    check()
  }

  return (
    <SafeAreaView style={[styles.sheet, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <Button label="Done" kind="plain" onPress={onClose} />
      </View>
      <View style={styles.content}>
        <Title>{"Can't reach OpenBot"}</Title>
        <Body>{url}</Body>
        {checking ? (
          <Body tone="plain">Checking…</Body>
        ) : result?.kind === 'failed' ? (
          <Body tone="plain">{failureMessage(result.failure, result.url)}</Body>
        ) : result ? (
          <Body tone="plain">OpenBot answered. Reconnecting…</Body>
        ) : null}
        <Button label="Try now" kind="primary" busy={checking} onPress={tryNow} />
        {result?.kind === 'failed' && <OpenSettings failure={result.failure} />}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: 16, marginVertical: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.lg },
  sheet: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 8 },
  content: { paddingHorizontal: 24, paddingTop: 16, gap: 12 },
})
