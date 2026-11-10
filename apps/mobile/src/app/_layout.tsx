import { LiveProvider, LiveStore } from '@openbot/client'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useColorScheme } from 'react-native'
import { Blocked } from '../components/blocked.tsx'
import { Connect } from '../components/connect.tsx'
import { FinishSetup } from '../components/finish-setup.tsx'
import { instanceApi } from '../lib/api.ts'
import { useAppActive } from '../lib/app-state.ts'
import type { CheckResult } from '../lib/connect/check.ts'
import { checkFromPhone } from '../lib/connect/phone.ts'
import { InstanceContext, type InstanceInfo } from '../lib/instance-context.ts'
import { reloadFolds } from '../lib/folds.ts'
import { forgetInstanceData } from '../lib/forget.ts'
import { type SavedInstance, useSavedInstance } from '../lib/saved-instance.ts'
import { kvStorage } from '../lib/storage.ts'
import { useColors } from '../lib/theme.ts'

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
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="auto" />
      <Root />
    </ThemeProvider>
  )
}

type VersionBlock = 'instanceTooOld' | 'appTooOld'
type Block = { kind: VersionBlock; url: string }

/** The version block a check found, undefined when the versions agree, or null when it couldn't tell (it failed). */
function versionBlock(result: CheckResult): VersionBlock | undefined | null {
  if (result.kind === 'failed') return null
  return result.kind === 'connected' ? undefined : result.kind
}

/**
 * From first launch to Chats (spec: Connect flow): Connect until an instance answers, Finish setup until its onboarding
 * is done, and a blocking screen while the app and the instance are too far apart in version. Once set up, the app
 * stays on the instance, never going back to Connect when it can't be reached.
 */
function Root() {
  const [saved, save] = useSavedInstance()
  // Before the instance is set up; once it is, the instance blocks for itself.
  const [block, setBlock] = useState<Block>()
  const [address, setAddress] = useState('')

  const onResult = (result: CheckResult) => {
    const found = versionBlock(result)
    if (found === null) return
    if (result.kind === 'connected') save({ url: result.url, instanceId: result.instanceId, setUp: result.setUp })
    if (found) setAddress(result.url)
    setBlock(found && { kind: found, url: result.url })
  }
  const changeAddress = () => {
    setAddress(saved?.url ?? block?.url ?? address)
    setBlock(undefined)
    save(undefined)
  }

  /** Drops what this phone keeps of its instance: its cache, drafts and folded sections, and the instance itself. */
  const forget = () => {
    // Unregistering this phone's push token joins here with Notifications on the phone (#116).
    forgetInstanceData(kvStorage)
    reloadFolds()
  }
  const moveTo = (instance: SavedInstance, options: { forget: boolean }) => {
    if (options.forget) forget()
    save(instance)
  }
  const disconnect = () => {
    forget()
    setAddress('')
    setBlock(undefined)
    save(undefined)
  }

  if (saved?.setUp) return <Instance key={saved.url} saved={saved} moveTo={moveTo} disconnect={disconnect} />
  if (block) return <Blocked key={block.url} kind={block.kind} url={block.url} onResult={onResult} onChangeAddress={changeAddress} />
  if (saved) return <FinishSetup key={saved.url} url={saved.url} onResult={onResult} onChangeAddress={changeAddress} />
  return <Connect initialAddress={address} onResult={onResult} />
}

/**
 * The app on the instance at `url`: its live store, following the event stream while in front. The instance's API
 * version is checked again each time the stream connects and the app comes to the foreground, as it may have been
 * updated meanwhile, and with every diagnosis the banner runs. A different instance answering at the address isn't
 * looked for: that's Settings → Instance's Edit address. Settings is a sheet with its own stack.
 */
function Instance({ saved, moveTo, disconnect }: { saved: SavedInstance } & Pick<InstanceInfo, 'moveTo' | 'disconnect'>) {
  const { url, instanceId } = saved
  const [api] = useState(() => instanceApi(url))
  const [store] = useState(() => new LiveStore({ api, storage: kvStorage }))
  const active = useAppActive()
  const [block, setBlock] = useState<VersionBlock>()
  const connected = useSyncExternalStore(store.subscribe, () => store.connected)
  const noteCheck = useCallback((result: CheckResult) => {
    const found = versionBlock(result)
    if (found !== null) setBlock(found)
  }, [])
  useEffect(() => {
    if (!active) return
    let current = true
    void checkFromPhone([url]).then((result) => current && noteCheck(result))
    return () => void (current = false)
  }, [connected, active, url, noteCheck])

  if (block) return <Blocked kind={block} url={url} onResult={noteCheck} />
  return (
    <InstanceContext value={{ url, instanceId, api, noteCheck, moveTo, disconnect }}>
      <LiveProvider store={store} active={active}>
        <Stack>
          <Stack.Screen name="settings" options={{ presentation: 'modal', headerShown: false }} />
        </Stack>
      </LiveProvider>
    </InstanceContext>
  )
}
