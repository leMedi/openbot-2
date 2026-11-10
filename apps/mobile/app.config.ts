import type { ConfigContext, ExpoConfig } from 'expo/config'
import { withPlainHttp } from './plugins/plain-http.ts'

// A placeholder until Shipping the app (#94) picks the real one; dev builds only meanwhile.
const bundleId = 'dev.openbot.app'

/**
 * Push notifications need the app's EAS project (its Expo push tokens belong to it, with the project's APNs key and
 * FCM credentials) and, on Android, Firebase's google-services.json. Both come with Shipping the app (#94); until then a
 * build given neither can't get a push token, and Settings → This phone → Notifications says so.
 */
const easProjectId = process.env.EAS_PROJECT_ID
const googleServicesFile = process.env.GOOGLE_SERVICES_FILE

export default ({ config }: ConfigContext): ExpoConfig =>
  withPlainHttp(
    {
      ...config,
      name: 'OpenBot',
      slug: 'openbot',
      version: '0.1.0',
      scheme: 'openbot',
      // Every orientation the phone allows, so the Screen can turn; the app's stack keeps every other screen portrait.
      orientation: 'default',
      userInterfaceStyle: 'automatic',
      ios: { bundleIdentifier: bundleId, supportsTablet: false },
      android: { package: bundleId, ...(googleServicesFile && { googleServicesFile }) },
      ...(easProjectId && { extra: { ...config.extra, eas: { projectId: easProjectId } } }),
      plugins: [
        'expo-router',
        'expo-sqlite',
        'expo-image',
        'expo-sharing',
        // Push: iOS's aps-environment entitlement, Android's POST_NOTIFICATIONS. Android draws OpenBot's notifications
        // itself, as conversations (modules/notifications-native).
        'expo-notifications',
        // The chat's + → Photo Library / Take Photo, and the microphone's prompt, which is Dictation's (the picker's plugin
        // writes it, and adds Android's RECORD_AUDIO).
        [
          'expo-image-picker',
          {
            photosPermission: 'OpenBot lets you send photos from your library to your bots.',
            cameraPermission: 'OpenBot lets you take a photo to send to your bots.',
            microphonePermission: 'OpenBot uses the microphone for dictation. What you say is transcribed on this phone and never leaves it.',
          },
        ],
      ],
    },
    { localNetworkUsage: 'OpenBot connects to your OpenBot computer on your network.' },
  )
