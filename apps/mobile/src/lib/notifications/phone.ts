import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications'
import { Platform } from 'react-native'
import { platform } from '../connect/phone.ts'
import type { NotificationsOs, Permission } from './registration.ts'
import { pushDataOf } from './push-data.ts'

/**
 * The EAS project the app's push tokens belong to, set for a build by `EAS_PROJECT_ID` (app.config.ts). Without one
 * (dev builds until Shipping the app, #94), this build can't get a push token, so it can't be notified.
 */
const projectId: string | undefined = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId

const permissionOf = ({ status, canAskAgain, ios }: Notifications.NotificationPermissionsStatus): Permission => ({
  // iOS's provisional (quiet) permission notifies too. Android says denied before it was ever asked, so a denial it
  // may still ask about counts as not decided.
  status:
    status === 'granted' || ios?.status === IosAuthorizationStatus.PROVISIONAL ? 'granted' : status === 'denied' && !canAskAgain ? 'denied' : 'undetermined',
  canAskAgain,
})

/**
 * Android's channels, which the phone's settings show: a bot's messages, and a card waiting for the owner. Android 13
 * shows the permission prompt only once a channel exists, so they're made before asking. Their ids are the native
 * presentation's (modules/notifications-native, which makes them too if a push comes first).
 */
async function makeChannels() {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('messages', { name: 'Messages', importance: AndroidImportance.HIGH })
  await Notifications.setNotificationChannelAsync('needs-you', { name: 'When a bot needs you', importance: AndroidImportance.HIGH })
}

/** The phone's notifications through expo-notifications. */
export const phoneOs: NotificationsOs = {
  permission: async () => permissionOf(await Notifications.getPermissionsAsync()),
  requestPermission: async () => {
    await makeChannels()
    return permissionOf(await Notifications.requestPermissionsAsync())
  },
  pushToken: async () => {
    if (!projectId) throw new Error("This build of the app isn't set up for push notifications.")
    await makeChannels()
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data
  },
  deviceName: Constants.deviceName?.trim() || (Platform.OS === 'ios' ? 'iPhone' : 'Android phone'),
  platform,
}

/** The chat open in front of the owner, whose notifications don't show while it is. */
let frontChat: string | undefined

/** The chat screen tells which chat is in front of the owner (undefined once it isn't), and its notifications go. */
export function setFrontChat(chatId: string | undefined) {
  frontChat = chatId
  if (chatId) void dismissChat(chatId)
}

/** Removes a chat's notifications from the phone's notification list, as the owner is reading it. */
export async function dismissChat(chatId: string) {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync()
    await Promise.all(
      shown
        .filter((notification) => pushDataOf(notification.request.content.data)?.chatId === chatId)
        .map((notification) => Notifications.dismissNotificationAsync(notification.request.identifier)),
    )
  } catch {
    // Left in the list; tapping it opens the chat anyway.
  }
}

/** Clears what the phone shows of an instance it leaves: its notifications and the badge. */
export function clearShown() {
  void Notifications.dismissAllNotificationsAsync().catch(() => {})
  void Notifications.setBadgeCountAsync(0).catch(() => {})
}

/** Sets the app's badge, the chats unread or with a card waiting. */
export function setBadge(count: number) {
  void Notifications.setBadgeCountAsync(count).catch(() => {})
}

// With the app in front, a notification shows as a banner, except for the chat the owner is reading (the instance
// mostly doesn't send those, as the chat sends the viewing heartbeat, but one may cross it).
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = pushDataOf(notification.request.content.data)
    const reading = !!data && data.chatId === frontChat
    return { shouldShowBanner: !reading, shouldShowList: !reading, shouldPlaySound: !reading && !data?.quiet, shouldSetBadge: true }
  },
})
