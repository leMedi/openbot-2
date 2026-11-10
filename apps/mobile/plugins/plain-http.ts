/// <reference types="node" />
// Lets the app reach an instance over plain HTTP at any address the owner types: a LAN IP, a `.local` name, or a
// Tailscale `*.ts.net` name (spec: The app → Networking; research #83).
import { type ConfigPlugin, withAndroidManifest, withDangerousMod, withInfoPlist } from 'expo/config-plugins'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const networkSecurityConfig = `<?xml version="1.0" encoding="utf-8"?>
<!-- Plain HTTP to any host, for an instance on a private network (plugins/plain-http.ts). -->
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>
`

/**
 * iOS: App Transport Security is exactly `{ NSAllowsArbitraryLoads: true }`, replacing Expo's whole block, whose
 * `NSAllowsLocalNetworking` makes iOS ignore `NSAllowsArbitraryLoads` and doesn't cover `*.ts.net`; plus the Local
 * Network prompt's text. Android: a network security config allowing cleartext, which `usesCleartextTraffic` alone
 * isn't (it's ignored once any config exists).
 */
export const withPlainHttp: ConfigPlugin<{ localNetworkUsage: string }> = (config, { localNetworkUsage }) => {
  config = withInfoPlist(config, (config) => {
    config.modResults.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true }
    config.modResults.NSLocalNetworkUsageDescription = localNetworkUsage
    return config
  })
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0]
    if (!application) throw new Error('plain-http: AndroidManifest.xml has no <application>')
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config'
    return config
  })
  return withDangerousMod(config, [
    'android',
    (config) => {
      const folder = join(config.modRequest.platformProjectRoot, 'app/src/main/res/xml')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'network_security_config.xml'), networkSecurityConfig)
      return config
    },
  ])
}
