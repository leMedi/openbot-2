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
      // Portrait only; the Screen will unlock landscape for itself.
      orientation: 'portrait',
      userInterfaceStyle: 'automatic',
      ios: { bundleIdentifier: bundleId, supportsTablet: false },
      android: { package: bundleId },
      plugins: ['expo-router', 'expo-sqlite'],
    },
    { localNetworkUsage: 'OpenBot connects to your OpenBot computer on your network.' },
  )
