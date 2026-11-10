import { badgeCount, useLive } from '@openbot/client'
import * as Notifications from 'expo-notifications'
import { router, useRootNavigationState } from 'expo-router'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useAppActive } from '../app-state.ts'
import { useInstance } from '../instance-context.ts'
import { setBadge } from './phone.ts'
import { pushDataOf } from './push-data.ts'
import type { NotificationsState } from './registration.ts'

/** This phone's notifications from the instance: the permission, its registration and switches. */
export function useNotifications(): NotificationsState {
  const { notifications } = useInstance()
  return useSyncExternalStore(notifications.subscribe, () => notifications.state)
}

/**
 * The phone's notifications while the app is on the instance (spec: Notifications on the phone): asks and registers
 * the first time Chats appears, checks the registration as the app comes back to the foreground, keeps the badge to
 * the chats unread or with a card waiting while it can see them, and opens the chat a notification was tapped for at
 * its message or card.
 */
export function useNotificationsBridge() {
  const { notifications } = useInstance()
  const live = useLive()
  const active = useAppActive()

  const shown = useRef(false)
  useEffect(() => {
    if (!active) return
    // The first time, Chats is appearing; later, the owner may have changed the permission or removed the phone.
    void (shown.current ? notifications.refresh() : notifications.chatsShown()).catch(() => {})
    shown.current = true
  }, [active, notifications])

  // From the instance's own state, not the phone's snapshot, which may be old.
  const count = live.connected && live.bots ? badgeCount(live.chats.values()) : undefined
  useEffect(() => {
    if (active && count !== undefined) setBadge(count)
  }, [active, count])

  const response = Notifications.useLastNotificationResponse()
  const navigationReady = !!useRootNavigationState()?.key
  useEffect(() => {
    if (!response || !navigationReady || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    // Handled once: the last response would otherwise open the chat again each time the app connects.
    Notifications.clearLastNotificationResponse()
    const data = pushDataOf(response.notification.request.content.data)
    if (!data) return
    // On Chats, wherever the owner was (a sheet, another chat, the Screen), then the chat at the message or card.
    if (router.canDismiss()) router.dismissTo('/')
    router.push({ pathname: '/chat/[chatId]', params: { chatId: data.chatId, message: data.messageId } })
  }, [response, navigationReady])
}
