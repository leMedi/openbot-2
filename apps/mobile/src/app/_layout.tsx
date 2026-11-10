import { LiveProvider, LiveStore } from '@openbot/client'
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { StyleSheet, useColorScheme } from 'react-native'
import { ScreenStack, ScreenStackItem } from 'react-native-screens'
import { Blocked } from '../components/blocked.tsx'
import { Connect } from '../components/connect.tsx'
import { FinishSetup } from '../components/finish-setup.tsx'
import { NotificationAvatars } from '../components/notification-avatars.tsx'
import { instanceApi } from '../lib/api.ts'
import { useAppActive } from '../lib/app-state.ts'
import type { CheckResult } from '../lib/connect/check.ts'
import { checkFromPhone } from '../lib/connect/phone.ts'
import { modelDownload } from '../lib/dictation/model.ts'
import { notificationAvatars } from '../lib/notifications/avatars.ts'
import { clearShown, phoneOs } from '../lib/notifications/phone.ts'
import { PhoneNotifications, retryUnregistering } from '../lib/notifications/registration.ts'
import { useNotificationsBridge } from '../lib/notifications/use-notifications.ts'
import { useNetworkChanges } from '../lib/network.ts'
import { phoneSnapshot } from '../lib/snapshot.ts'
import { InstanceContext, type InstanceInfo } from '../lib/instance-context.ts'
import { reloadFolds } from '../lib/folds.ts'
import { forgetInstanceData } from '../lib/forget.ts'
import { type SavedInstance, useSavedInstance } from '../lib/saved-instance.ts'
import { kvStorage } from '../lib/storage.ts'
import { useColors } from '../lib/theme.ts'

export default function RootLayout() {
  // A voice model download under way when the app last ran carries on (the model belongs to the phone, not to an instance).
  useEffect(() => modelDownload.resume(), [])
  // Instances the phone left while they couldn't be reached are told again to stop notifying it.
  useEffect(() => void retryUnregistering(kvStorage, (url) => instanceApi(url).devices), [])
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

  /**
   * Drops what this phone keeps of its instance: its cache, drafts and folded sections, its notifications (the
   * instance is told to stop sending them by Instance as it's left) and its bots' avatars kept for them, and the
   * instance itself.
   */
  const forget = () => {
    clearShown()
    notificationAvatars?.clear()
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
  return (
    <Portrait>
      {block ? (
        <Blocked key={block.url} kind={block.kind} url={block.url} onResult={onResult} onChangeAddress={changeAddress} />
      ) : saved ? (
        <FinishSetup key={saved.url} url={saved.url} onResult={onResult} onChangeAddress={changeAddress} />
      ) : (
        <Connect initialAddress={address} onResult={onResult} />
      )}
    </Portrait>
  )
}

/**
 * Keeps a screen drawn outside the app's stack (Connect, Finish setup, the version blocks) portrait: the app turns with
 * the phone so the Screen can, and only a native screen can say which way it may turn.
 */
function Portrait({ children }: { children: ReactNode }) {
  return (
    <ScreenStack style={StyleSheet.absoluteFill}>
      <ScreenStackItem screenId="portrait" screenOrientation="portrait" headerConfig={{ hidden: true }} style={StyleSheet.absoluteFill}>
        {children}
      </ScreenStackItem>
    </ScreenStack>
  )
}

/**
 * The app on the instance at `url`: its live store, following the event stream while in front, with its snapshot on
 * the phone, so the chats and their loaded messages show, read-only, while the instance can't be reached (spec:
 * Offline). The instance's API version is checked again each time the stream connects and the app comes to the
 * foreground, as it may have been updated meanwhile, and with every diagnosis the banner runs. A different instance
 * answering at the address isn't looked for: that's Settings → Instance's Edit address. Settings, New bot and New
 * group chat are sheets with their own stacks.
 */
function Instance({ saved, moveTo, disconnect }: { saved: SavedInstance } & Pick<InstanceInfo, 'moveTo' | 'disconnect'>) {
  const { url, instanceId } = saved
  const [api] = useState(() => instanceApi(url))
  const [store] = useState(() => new LiveStore({ api, storage: kvStorage, snapshot: phoneSnapshot(kvStorage, instanceId) }))
  const [notifications] = useState(() => new PhoneNotifications({ storage: kvStorage, devices: api.devices, os: phoneOs, instance: { url, instanceId } }))
  // Leaving the instance unregisters the phone first, while its registration is still kept (the instance's keys go next).
  const leaving = (options: { forget: boolean }) => {
    if (options.forget) void notifications.forget()
  }
  const active = useAppActive()
  // Saved now as the app goes to the background, where it may be ended before the next save is due.
  useEffect(() => {
    if (!active) store.saveSnapshot()
  }, [active, store])
  // A stream on a network that's gone would only be noticed by the stall watchdog: it's reopened at once, resuming.
  useNetworkChanges(() => store.reconnect())
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

  if (block) {
    return (
      <Portrait>
        <Blocked kind={block} url={url} onResult={noteCheck} />
      </Portrait>
    )
  }
  return (
    <InstanceContext
      value={{
        url,
        instanceId,
        api,
        noteCheck,
        moveTo: (instance, options) => {
          leaving(options)
          moveTo(instance, options)
        },
        disconnect: () => {
          leaving({ forget: true })
          disconnect()
        },
        notifications,
      }}
    >
      <LiveProvider store={store} active={active}>
        <NotificationsBridge />
        <NotificationAvatars />
        {/* Portrait everywhere but the Screen, which turns with the phone (spec: Screen and take-over → Layout). */}
        <Stack screenOptions={{ orientation: 'portrait' }}>
          <Stack.Screen name="screen/[botId]" options={{ presentation: 'fullScreenModal', headerShown: false, orientation: 'all', animation: 'fade' }} />
          <Stack.Screen name="settings" options={{ presentation: 'modal', headerShown: false }} />
          <Stack.Screen name="new-bot" options={{ presentation: 'modal', headerShown: false }} />
          <Stack.Screen name="new-group" options={{ presentation: 'modal', headerShown: false }} />
        </Stack>
      </LiveProvider>
    </InstanceContext>
  )
}

/** The phone's notifications while the app is on the instance: asking, the badge, and taps opening their chat. */
function NotificationsBridge() {
  useNotificationsBridge()
  return null
}
