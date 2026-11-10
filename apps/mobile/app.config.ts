import type { ConfigContext, ExpoConfig } from 'expo/config'
import { withPlainHttp } from './plugins/plain-http.ts'

// A placeholder until Shipping the app (#94) picks the real one; dev builds only meanwhile.
const bundleId = 'dev.openbot.app'

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
      android: { package: bundleId },
      plugins: [
        'expo-router',
        'expo-sqlite',
        'expo-image',
        'expo-sharing',
        // The chat's + → Photo Library / Take Photo. The microphone's prompt is left to Dictation (#115).
        [
          'expo-image-picker',
          {
            photosPermission: 'OpenBot lets you send photos from your library to your bots.',
            cameraPermission: 'OpenBot lets you take a photo to send to your bots.',
          },
        ],
      ],
    },
    { localNetworkUsage: 'OpenBot connects to your OpenBot computer on your network.' },
  )
