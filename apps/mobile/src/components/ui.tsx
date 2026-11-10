import type { ReactNode } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import type { Failure } from '../lib/connect/check.ts'
import { platform } from '../lib/connect/phone.ts'
import { SafeAreaView } from 'react-native-safe-area-context'
import { radii, text, useColors } from '../lib/theme.ts'

/** A full screen of its own, before Chats: centred content in a narrow column. */
export function FullScreen({ children }: { children: ReactNode }) {
  const colors = useColors()
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.column}>{children}</View>
    </SafeAreaView>
  )
}

export function Title({ children }: { children: ReactNode }) {
  const colors = useColors()
  return (
    <Text accessibilityRole="header" style={[text.xl, styles.title, { color: colors.foreground }]}>
      {children}
    </Text>
  )
}

export function Body({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'error' | 'plain' }) {
  const colors = useColors()
  const color = tone === 'error' ? colors.destructiveForeground : tone === 'plain' ? colors.foreground : colors.mutedForeground
  return <Text style={[text.lg, { color }]}>{children}</Text>
}

/** A full-width button: `primary` for the screen's main action, `plain` for a link-like one. */
export function Button({
  label,
  onPress,
  kind = 'secondary',
  busy = false,
  disabled = false,
}: {
  label: string
  onPress: () => void
  kind?: 'primary' | 'secondary' | 'plain'
  busy?: boolean
  disabled?: boolean
}) {
  const colors = useColors()
  const background = kind === 'primary' ? colors.primary : kind === 'secondary' ? colors.secondary : 'transparent'
  const color = kind === 'primary' ? colors.primaryForeground : kind === 'plain' ? colors.link : colors.foreground
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Text style={[text.lg, styles.buttonLabel, { color }]}>{label}</Text>}
    </Pressable>
  )
}

/** Open Settings, for iOS's Local Network denial: the owner allows it in the app's settings. */
export function OpenSettings({ failure }: { failure: Failure }) {
  if (failure.kind !== 'localNetwork' || platform !== 'ios') return null
  return <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  column: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 12, width: '100%', maxWidth: 440, alignSelf: 'center' },
  title: { fontWeight: '600' },
  button: { height: 44, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonLabel: { fontWeight: '600' },
})
