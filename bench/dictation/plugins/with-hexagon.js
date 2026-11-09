// whisper.rn reaches the Snapdragon Hexagon NPU through the FastRPC loader, which the app must declare (optional, so
// phones without it still install).
const { withAndroidManifest } = require('expo/config-plugins')

module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application[0]
    app['uses-native-library'] = [{ $: { 'android:name': 'libcdsprpc.so', 'android:required': 'false' } }]
    return mod
  })
