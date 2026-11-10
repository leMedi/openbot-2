import Constants from 'expo-constants'
import { Directory, File, Paths } from 'expo-file-system'
import { Platform } from 'react-native'
import { type AvatarFiles, type AvatarManifest, AvatarCache, type CachedBot } from './avatar-cache.ts'

/** The app group the app shares with its Notification Service Extension (app.config.ts, plugins/notification-service.ts). */
const appGroup: string | undefined = Constants.expoConfig?.extra?.appGroup

/**
 * The avatars folder in the app group's container: each bot's `<botId>.png`, which the extension reads
 * (targets/notification-service), and the app's own `manifest.json` of what's drawn. Undefined off iOS, or in a build
 * without the app group.
 */
function appGroupFiles(): AvatarFiles | undefined {
  if (Platform.OS !== 'ios' || !appGroup) return undefined
  const container = Paths.appleSharedContainers[appGroup]
  if (!container) return undefined
  const folder = new Directory(container, 'avatars')
  const manifest = () => new File(folder, 'manifest.json')
  const avatar = (botId: string) => new File(folder, `${encodeURIComponent(botId)}.png`)
  const ensureFolder = () => {
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true })
  }
  return {
    readManifest: () => {
      try {
        return manifest().exists ? (JSON.parse(manifest().textSync()) as AvatarManifest) : undefined
      } catch {
        return undefined
      }
    },
    writeManifest: (entries) => {
      ensureFolder()
      manifest().write(JSON.stringify(entries))
    },
    writeAvatar: (botId, png) => {
      ensureFolder()
      avatar(botId).write(png, { encoding: 'base64' })
    },
    removeAvatar: (botId) => {
      const file = avatar(botId)
      if (file.exists) file.delete()
    },
    clear: () => {
      if (folder.exists) folder.delete()
    },
  }
}

/** Draws a bot's avatar as a PNG (base64); set by the mounted NotificationAvatars, which draws with react-native-svg. */
let drawer: ((bot: CachedBot) => Promise<string>) | undefined

export function setAvatarDrawer(draw: typeof drawer) {
  drawer = draw
}

const files = appGroupFiles()

/**
 * The bots' avatars for iOS's notifications, kept in the app group; nothing on Android, whose notifications don't show
 * them yet, or where there's no app group.
 */
export const notificationAvatars = files
  ? new AvatarCache({
      files,
      render: (bot) => {
        if (!drawer) return Promise.reject(new Error('The avatars aren’t being drawn'))
        return drawer(bot)
      },
    })
  : undefined
