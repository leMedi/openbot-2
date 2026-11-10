import { LiveProvider, LiveStore } from '@openbot/client'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import { StyleSheet, Text, useColorScheme, View } from 'react-native'
import { instanceApi } from '../lib/api.ts'
import { useAppActive } from '../lib/app-state.ts'
import { devInstanceAddress } from '../lib/instance.ts'
import { draftStorage } from '../lib/storage.ts'
import { text, useColors } from '../lib/theme.ts'

export default function RootLayout() {
  const dark = useColorScheme() === 'dark'
  const colors = useColors()
  const base = dark ? DarkTheme : DefaultTheme
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.link,
      background: colors.background,
      card: colors.background,
      text: colors.foreground,
      border: colors.border,
      notification: colors.statusUnread,
    },
  }
  const address = devInstanceAddress()
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="auto" />
      {address ? <Instance address={address} /> : <NoInstance />}
    </ThemeProvider>
  )
}

/** The app connected to the instance at `address`: its live store, following the event stream while in front. */
function Instance({ address }: { address: string }) {
  const [store] = useState(() => new LiveStore({ api: instanceApi(address), storage: draftStorage }))
  const active = useAppActive()
  return (
    <LiveProvider store={store} active={active}>
      <Stack />
    </LiveProvider>
  )
}

/** Until the Connect screen exists, the dev build's address comes from its environment. */
function NoInstance() {
  const colors = useColors()
  return (
    <View style={[styles.center, { backgroundColor: colors.background }]}>
      <Text style={[text.lg, { color: colors.foreground }]}>No instance set</Text>
      <Text style={[text.base, styles.hint, { color: colors.mutedForeground }]}>
        Set EXPO_PUBLIC_OPENBOT_URL in apps/mobile/.env.local to the address you open OpenBot at in your browser, then restart Metro.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  hint: { textAlign: 'center' },
})
