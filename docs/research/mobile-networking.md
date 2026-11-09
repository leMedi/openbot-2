# Reaching a plain-HTTP private instance from iOS and Android

Research for [#83](https://github.com/leMedi/openbot-2/issues/83) (map #81). The question: what an Expo app needs in order to talk to an **instance** at an address the user typed in, over plain HTTP on a private network (a LAN IP, a Tailscale `*.ts.net` / MagicDNS name, or a `.local` name). Sources were read on 2026-11-09. Versions in play: Expo SDK 58 (`expo@58.0.19`), React Native 0.88.1, App Review Guidelines last updated 2026-10-16.

## Conclusion

1. **iOS: set `NSAllowsArbitraryLoads = YES` and nothing else in `NSAppTransportSecurity`.** Also set `NSLocalNetworkUsageDescription`. `NSAllowsLocalNetworking` alone does not cover `http://box.tailnet.ts.net`, because that is a fully qualified public-style name. Worse, when `NSAllowsLocalNetworking` is present, iOS *ignores* `NSAllowsArbitraryLoads`. Expo's prebuild template ships with `NSAllowsLocalNetworking = true`, so the app config has to replace the whole ATS dictionary. Home Assistant, Jellyfin (Swiftfin) and Immich all ship exactly this config on the App Store.
2. **Android: ship a Network Security Config with `<base-config cleartextTrafficPermitted="true">`.** Don't rely on `android:usesCleartextTraffic` / `expo-build-properties`. That attribute is ignored whenever an NSC is present, and it is deprecated and ignored for apps targeting API 38 and up. Home Assistant, Jellyfin and Immich all ship this same base-config. Domain rules can't express "any user-entered LAN address".
3. **Local-network permission prompts happen on both platforms for LAN addresses, but not for Tailscale addresses.** On iOS, a TCP connection to a LAN IP or a `.local` lookup triggers the Local Network alert, which may deny the very first attempt. VPN interfaces (Tailscale) are explicitly *not* "local network". On Android 17, apps targeting API 37 must request `ACCESS_LOCAL_NETWORK` at runtime to reach LAN hosts. Expo SDK 58 targets API 36, so this isn't needed yet, but React Native `main` already targets 37.
4. **Tailscale on the phone makes `*.ts.net` names and `100.x` IPs work, but only while the Tailscale VPN is connected.** It also opens a cleaner path: `tailscale serve` gives the instance a real Let's Encrypt HTTPS URL at `https://box.tailnet.ts.net`. That URL needs no ATS or cleartext exception at all. The app should accept both `http://` and `https://`, and the instance docs should recommend `tailscale serve`.
5. **Streaming works the same over HTTP and HTTPS.** Use `expo/fetch`, which runs on `URLSession` on iOS and OkHttp on Android, and which Expo installs as the global `fetch` on iOS and Android. It exposes `response.body.getReader()`, so SSE can be parsed from a streamed fetch. Both native stacks enforce the same ATS / cleartext rules, so the configs above cover streaming too.
6. **Review:** Apple requires a written justification for `NSAllowsArbitraryLoads` but accepts it for self-hosted-server clients; the three precedents above are all on the App Store with it. Google Play has no equivalent justification step for cleartext. The real review risk is somewhere else: giving App Review a reachable instance (guideline 2.1), and not making the app depend on installing Tailscale (4.2.3). That belongs to the "Store review" ticket.

## iOS

### App Transport Security (ATS)

ATS makes the URL Loading System (`URLSession`) require HTTPS. Plain `http://` loads are blocked unless the app declares an exception ([NSAppTransportSecurity](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity), [Preventing insecure network connections](https://developer.apple.com/documentation/security/preventing-insecure-network-connections)). ATS does not apply to lower-level APIs like Network.framework or raw sockets (same page). React Native networking and `expo/fetch` both use `URLSession` (see Streaming below), so ATS applies to them.

What `NSAllowsLocalNetworking` covers ([doc](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)):

- It allows "unqualified domains, `.local` domains, and IP addresses using IPv4 or IPv6".
- On iOS 10–16 all three were allowed by default. "In iOS 17, iPadOS 17, and macOS 14, ATS no longer allows connections to IP addresses by default." You either use this key or list IPs/CIDR ranges in `NSExceptionDomains`.
- "The local networking exception tells newer versions of the OS to ignore the arbitrary loads key."

What `NSAllowsArbitraryLoads` does ([doc](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloads)):

- It disables ATS for every domain not listed in `NSExceptionDomains`.
- "You must supply a justification during App Store review if you set the key's value to `YES`."
- "In iOS 10 and later … the value of the `NSAllowsArbitraryLoads` key is ignored—and the default value of `NO` used instead—if any of the following keys are present: `NSAllowsArbitraryLoadsForMedia`, `NSAllowsArbitraryLoadsInWebContent`, `NSAllowsLocalNetworking`."

What this means for each address type OpenBot must support:

| Address the user types | Covered by `NSAllowsLocalNetworking`? | Covered by `NSAllowsArbitraryLoads` (alone)? |
|---|---|---|
| `http://192.168.1.20:3000` (LAN IP) | yes | yes |
| `http://100.101.102.103:3000` (Tailscale IP) | yes ("IP addresses") | yes |
| `http://openbot.local:3000` | yes | yes |
| `http://openbot:3000` (MagicDNS short name) | yes (unqualified) | yes |
| `http://openbot.tail1234.ts.net:3000` | **no**, it's a qualified domain | yes |
| `http://openbot.home.arpa`, a split-DNS name, or the owner's own domain on a LAN | **no** | yes |

The narrowest config that still covers `*.ts.net` is `NSAllowsLocalNetworking` plus an `NSExceptionDomains` entry for `ts.net` with `NSIncludesSubdomains` and `NSExceptionAllowsInsecureHTTPLoads`. It still needs an App Review justification, because `NSExceptionAllowsInsecureHTTPLoads` is on Apple's "requires justification" list ([Provide Justification for Exceptions](https://developer.apple.com/documentation/security/preventing-insecure-network-connections)). It also still fails for custom split-DNS names. `NSAllowsLocalNetworking` by itself is *not* on that list. Because the justification can't be avoided either way, `NSAllowsArbitraryLoads` alone is the simpler and more complete choice. Apple's list of acceptable justifications includes "The app must support connecting to devices that cannot be upgraded to use secure connections, and that must be accessed using public host names."

#### The Expo trap

Expo's iOS prebuild template ([`expo-template-bare-minimum/ios/HelloWorld/Info.plist`](https://github.com/expo/expo/blob/c3a8c9e044/templates/expo-template-bare-minimum/ios/HelloWorld/Info.plist)) ships:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key><false/>
  <key>NSAllowsLocalNetworking</key><true/>
</dict>
```

So out of the box an Expo app reaches LAN IPs and `.local`, but **not** `http://*.ts.net`. Adding only `NSAllowsArbitraryLoads: true` next to the template's `NSAllowsLocalNetworking` would be silently ignored. Expo merges `ios.infoPlist` over the native Info.plist with a *shallow* spread (`{...modResults, ...config.ios.infoPlist}`, [`withIosBaseMods.ts`](https://github.com/expo/expo/blob/main/packages/@expo/config-plugins/src/plugins/withIosBaseMods.ts)). That means declaring the whole `NSAppTransportSecurity` dictionary in `app.config.ts` replaces the template's dictionary:

```ts
ios: {
  infoPlist: {
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }, // replaces the template dict; no NSAllowsLocalNetworking
    NSLocalNetworkUsageDescription: "OpenBot connects to your OpenBot instance on your local network.",
  },
},
```

### Local Network privacy prompt

From [TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy), revised 2026-10-06:

- iOS 14+. The first local network operation shows a system alert, and the user's choice is remembered. "If your app accesses the local network, add the `NSLocalNetworkUsageDescription` property." The [key's doc](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription) says this includes "direct unicast or multicast connections to local hosts".
- **Definition:** "A local network is an IP network associated with a broadcast-capable network interface. Such interfaces include Wi-Fi and Ethernet, but not cellular (WWAN) or VPN." An outgoing TCP connection to a local network address needs access. The check sits "deep in the networking stack" and applies to `URLSession` and everything else.
- **Tailscale IPs and `*.ts.net`:** traffic goes over the Tailscale VPN tunnel, so it is not local network traffic and does not prompt. That follows from the definition above. TN3179 has no Tailscale-specific statement.
- **`.local`:** "Resolving a local DNS name" (one ending in `.local`) requires access. Resolving non-local names with the system resolver does not.
- **First-attempt failure:** "it may deny the operation immediately, before the user has responded to the alert". Apple recommends `waitsForConnectivity` or "appropriate retry logic". The app's connect flow should retry after the alert, or treat the first failure as "waiting for permission".
- If the app is in the background and the privilege is still undetermined, the operation is denied silently.
- The simulator doesn't implement local network privacy, so test this on a device.
- "If your app allows people to enter an arbitrary network address, consider what happens if they enter a local network address." That describes OpenBot exactly.

## Android

### Cleartext HTTP

- Apps targeting API 28+ block cleartext by default. To allow it for any host, set `cleartextTrafficPermitted="true"` on `<base-config>` in a Network Security Config ([Network security configuration](https://developer.android.com/privacy-and-security/security-config)). A `<domain>` element matches a domain name with optional `includeSubdomains`. The docs give no CIDR or wildcard-IP form, so a "private ranges only" rule can't be written.
- `android:usesCleartextTraffic` ([`<application>` doc](https://developer.android.com/guide/topics/manifest/application-element)): "This flag is ignored on Android 7.0 (API level 24) and above if an Android Network Security Config is present", and "This attribute is getting deprecated and will be ignored for apps targeting API levels 38 and above."
- `expo-build-properties` exposes only `android.usesCleartextTraffic` and sets just that manifest attribute ([docs](https://docs.expo.dev/versions/latest/sdk/build-properties/), [source](https://github.com/expo/expo/blob/main/packages/expo-build-properties/src/android.ts)). It has no NSC option. OpenBot should therefore ship a small config plugin that writes `res/xml/network_security_config.xml` and sets `android:networkSecurityConfig`.
- Platform HTTP stacks enforce the flag, and third-party libraries are "strongly encouraged" to read `NetworkSecurityPolicy.isCleartextTrafficPermitted()`. OkHttp, which `expo/fetch` uses on Android, does.

Precedents, all the same shape:

| App | File | Content |
|---|---|---|
| Home Assistant | [`app/src/main/res/xml/network_security_config.xml`](https://github.com/home-assistant/android/blob/main/app/src/main/res/xml/network_security_config.xml) | `<base-config cleartextTrafficPermitted="true">`, system + user CAs ("for those who don't have SSL setup") |
| Jellyfin | [`app/src/main/res/xml/network_security_config.xml`](https://github.com/jellyfin/jellyfin-android/blob/master/app/src/main/res/xml/network_security_config.xml) | same, with `tools:ignore="InsecureBaseConfiguration"` |
| Immich | [`mobile/android/.../network_security_config.xml`](https://github.com/immich-app/immich/blob/main/mobile/android/app/src/main/res/xml/network_security_config.xml) | same, plus `usesCleartextTraffic="true"` in the manifest |

The three apps also trust **user-added CAs** (`<certificates src="user"/>`), so people running their own CA can use HTTPS. That is optional for OpenBot.

### Local network permission (Android 17)

From [Local network permission](https://developer.android.com/privacy-and-security/local-network-permission) and [Android 17 behavior changes](https://developer.android.com/about/versions/17/behavior-changes-17):

- Apps targeting API 37 (Android 17) are "blocked by default". They must declare `ACCESS_LOCAL_NETWORK` and request it at runtime, or use a system picker. Outgoing TCP to a local address counts, and so does `.local` resolution. The rule applies to "all networking APIs", OkHttp included. Without the permission, TCP connections "typically result in a timeout error".
- Apps targeting API < 37 get an implicit grant through `INTERNET`. Google says: "don't add `ACCESS_LOCAL_NETWORK` to your manifest or request it at runtime" until you target 37.
- The permission belongs to the `NEARBY_DEVICES` group, so users who already granted Bluetooth-type permissions aren't prompted again.
- Timing for OpenBot: Expo SDK 58 → React Native 0.88.1, which targets API 36 ([`libs.versions.toml@v0.88.1`](https://github.com/facebook/react-native/blob/v0.88.1/packages/react-native/gradle/libs.versions.toml)). React Native `main` already targets 37. Play requires API 36 for new apps and updates from 2026-08-31 ([target SDK requirements](https://developer.android.com/google/play/requirements/target-sdk)), so API 37 will likely become mandatory around August 2027. Plan the runtime request into the connect flow now.
- Precedent: Home Assistant's [`AndroidManifest.xml`](https://github.com/home-assistant/android/blob/main/app/src/main/AndroidManifest.xml) already declares `android.permission.ACCESS_LOCAL_NETWORK`. In GitNex (a Gitea client), [PR #1621](https://zff.dev/gitnex/GitNex/pulls/1621) argued for requesting it unconditionally, because self-hosted LAN servers can sit behind real domain names. The maintainer preferred requesting only for private IPs and local domains.
- **Open question:** Google's page doesn't say whether traffic through a VPN interface (Tailscale's `VpnService`, `100.64.0.0/10`) counts as "local network". By analogy with Apple it probably doesn't, but this is unverified. Test on an Android 17 device with targetSdk 37 before relying on it.

## Tailscale on the phone

- Tailscale IPs come from `100.64.0.0/10` (CGNAT space) and stay the same as the phone moves between networks ([100.x addresses](https://tailscale.com/kb/1015/100.x-addresses)).
- MagicDNS gives each device a FQDN like `monitoring.yak-bebop.ts.net`, and adds search domains so short names work ([MagicDNS](https://tailscale.com/kb/1081/magicdns)). The resolver is `100.100.100.100`, a device-local service that "resolves hostnames in your tailnet locally using MagicDNS" ([Quad100](https://tailscale.com/kb/1381/what-is-quad100)). Clients "must be configured to use Tailscale DNS settings" ([DNS](https://tailscale.com/kb/1054/dns)).
- **What follows for the app** (an inference; Tailscale has no mobile-specific page on this): `*.ts.net` names and `100.x` IPs only resolve and route while the Tailscale VPN is up on the phone. When it's off, a `ts.net` name fails at DNS. The connect screen should tell "can't resolve" apart from "connection refused/timed out", and suggest "Is Tailscale connected?" for `ts.net` / `100.x` addresses.
- **HTTPS without a public CA headache:** with MagicDNS and HTTPS Certificates enabled for the tailnet, `tailscale cert` gets a Let's Encrypt certificate for `machine.tailnet.ts.net` ([Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)). `tailscale serve 3000` proxies `https://<device>.<tailnet>.ts.net` to `http://127.0.0.1:3000` ([Serve](https://tailscale.com/kb/1312/serve)). A Let's Encrypt certificate passes ATS and Android's defaults, including CT, which is on by default for API 37. On that URL the app needs **no** cleartext exception. One caveat: machine names are published in the Certificate Transparency logs (same page).

## Streaming (fetch / SSE)

- `expo/fetch` is a "WinterCG-compliant Fetch API". It supports streamed bodies via `resp.body.getReader()`, and "On Android and iOS, `expo/fetch` is also installed as the global `fetch`" (opt out with `EXPO_PUBLIC_USE_RN_FETCH=1`) ([docs](https://docs.expo.dev/versions/latest/sdk/expo/)).
- Native transport: iOS uses `URLSession` ([`ExpoFetchModule.swift`](https://github.com/expo/expo/blob/main/packages/expo/ios/Expo/Fetch/ExpoFetchModule.swift)) and Android uses React Native's `OkHttpClientProvider` ([`ExpoFetchModule.kt`](https://github.com/expo/expo/blob/main/packages/expo/android/src/main/java/expo/modules/fetch/ExpoFetchModule.kt)). ATS and the NSC therefore apply exactly as described above. Plain HTTP and HTTPS need nothing different for streaming, and neither does a LAN versus a Tailscale address.
- React Native has no built-in `EventSource`. Parse SSE from the streamed fetch body. The webapp may already do this if it consumes `@openbot/api-contract` streams with fetch.
- Not verified here: whether any proxy in the path (for example `tailscale serve`) buffers responses. Check with a real streaming endpoint during prototyping.

## Store review

- **Apple:** the `NSAllowsArbitraryLoads` justification is filled in during submission ([Provide Justification for Exceptions](https://developer.apple.com/documentation/security/preventing-insecure-network-connections)). Self-hosted clients ship with it:
  - Home Assistant ([`Sources/App/Resources/Info.plist`](https://github.com/home-assistant/iOS/blob/main/Sources/App/Resources/Info.plist)): `NSAllowsArbitraryLoads` only, plus `NSLocalNetworkUsageDescription` "Locate and communicate with your Home Assistant instance."
  - Jellyfin Swiftfin ([`Swiftfin/Resources/Info.plist`](https://github.com/jellyfin/Swiftfin/blob/57893014a5/Swiftfin/Resources/Info.plist)): `NSAllowsArbitraryLoads` only, plus "uses the local network to connect to your Jellyfin server on your Wi-Fi network."
  - Immich ([`mobile/ios/Runner/Info.plist`](https://github.com/immich-app/immich/blob/81778c8c4a/mobile/ios/Runner/Info.plist)): `NSAllowsArbitraryLoads` only, plus "connect to the local server using IP address".

  None of the three sets `NSAllowsLocalNetworking`, which fits the "ignored" rule above. All three are live App Store apps, so Apple does accept this exception for this kind of client. That is inferred from their being published; Apple doesn't publish review decisions.
- **Google Play:** has no justification step for cleartext. It only enforces target-API deadlines. Lint flags `InsecureBaseConfiguration`, which Jellyfin suppresses.
- **The actual risks** sit outside networking and belong to the "Store review" ticket:
  - Guideline 2.1 asks for "full access to your app … plus any other hardware or resources that might be needed", and asks you to "enable backend services so that they're live and accessible during review". The reviewer needs a reachable instance or a demo mode.
  - Guideline 4.2.3(i): "Your app should work on its own without requiring installation of another app to function." Don't make Tailscale mandatory in the app's copy; LAN and HTTPS addresses must work too ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).

## Checklist for the spec

- iOS `app.config.ts`: `NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }` (replacing Expo's template dict), plus `NSLocalNetworkUsageDescription`. No `NSBonjourServices` unless discovery is added later.
- Android: a config plugin that writes an NSC with `<base-config cleartextTrafficPermitted="true">` (system CAs, optionally user CAs) and wires `android:networkSecurityConfig`. When targetSdk reaches 37, add `ACCESS_LOCAL_NETWORK` and a runtime request in the connect flow, gated on the address being a private IP or `.local`, or simply always requested.
- Connect flow: accept `http://` and `https://`. Retry once after the first iOS failure, which may be the Local Network alert. Map errors to hints ("allow Local Network in Settings", "is Tailscale connected?").
- Instance docs and the QR code: prefer `tailscale serve` HTTPS URLs where available.
- Networking: use `expo/fetch` (the default global) for streaming, with SSE parsed from `body.getReader()`.
