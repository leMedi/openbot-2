# Push notifications from self-hosted instances

Research for [#86](https://github.com/leMedi/openbot-2/issues/86), part of the mobile map [#81](https://github.com/leMedi/openbot-2/issues/81). Sources were read on 2026-11-09.

**The question.** Every OpenBot **instance** is self-hosted, unauthenticated (ADR 0003) and reached over a private network, but there should be one official store app. How does each instance get a notification onto a phone running that app?

## Recommendation

- **Official builds: each instance sends straight to the Expo Push Service for the app's single EAS project, with Enhanced Push Security turned off.** There is no OpenBot relay in v1. The phone registers its `ExpoPushToken` with the instance over the tailnet or LAN. The instance then POSTs to `exp.host` with no credentials. Keep payloads minimal: a generic title and body, plus IDs in `data`. The app fetches the real content from the instance when it opens. If abuse or the shared rate limit ever becomes a problem, add a thin OpenBot relay that holds the Expo access token, following the pattern Home Assistant and Nextcloud use. The instance-side API doesn't need to change for that.
- **Self-built apps: the same code path, using the builder's own EAS project.** A different bundle ID means a different EAS project, with the builder's own APNs and FCM credentials uploaded to EAS. Their tokens only work for their project, and the instance code doesn't change. If they turn on push security for their own project, an optional `EXPO_ACCESS_TOKEN` env var on the instance is enough.
- **Rejected for now:** sending directly to FCM or APNs from instances, and ntfy or UnifiedPush (reasons below). End-to-end encrypted previews are possible later and are described under Privacy.

## Expo Push Service facts

| Topic | Fact | Source |
|---|---|---|
| Endpoint | `POST https://exp.host/--/api/v2/push/send`; receipts are at `/push/getReceipts` | [Sending notifications](https://docs.expo.dev/push-notifications/sending-notifications/) |
| Auth | "This API currently does not require any authentication." Optional "enhanced push security" is turned on in the Expo dashboard. After that, requests without a valid access token fail with `UNAUTHORIZED`. Tokens go in `Authorization: Bearer` or the SDK's `accessToken` | same |
| Rate limit | 600 notifications per second **per project**. Requests above that get `TOO_MANY_REQUESTS` or `MessageRateExceeded`; retry 429s and 5xx with exponential backoff | same; [FAQ](https://docs.expo.dev/push-notifications/faq/) |
| Batching | Up to 100 messages per request, and up to 1000 receipt IDs per receipt lookup. All recipients in one request must belong to one project (`PUSH_TOO_MANY_EXPERIENCE_IDS`) | Sending notifications |
| Tickets vs receipts | A ticket with `ok` only means Expo accepted the message. Check receipts about 15 minutes later; they are cleared after 24 hours | same |
| Dead tokens | `DeviceNotRegistered` means stop sending to that token. The ExpoPushToken "never expires" otherwise, but it changes if `applicationId` changes | Sending notifications; FAQ |
| Payload | At most 4096 bytes in total, as sent to Apple and Google. Fields: `title`, `body`, `data`, `ttl` (default is the provider's, 4 weeks), `priority`, `threadId`/`collapseId`, `categoryId`, `mutableContent`, `contentAvailable`, `channelId` | Sending notifications |
| Cost | Free: "There is no cost associated with sending notifications through Expo push notification service" | FAQ |
| Token scope | `getExpoPushTokenAsync` needs the EAS `projectId`. A token is tied to that project | [expo-notifications SDK](https://docs.expo.dev/versions/latest/sdk/notifications/) |
| Escape hatch | `getDevicePushTokenAsync` returns the native FCM or APNs token for use with any other service | SDK; FAQ |

### Is it safe to leave push security off?

Push security has to stay off if instances send directly. The only way to authenticate to Expo is an Expo access token, and that is an account credential. Personal tokens "can perform actions on your behalf". Robot-user tokens are limited only by an account role ([Programmatic access](https://docs.expo.dev/accounts/programmatic-access/)). Shipping one inside every self-hosted image would hand an account credential to every user.

With security off, anyone who knows a device's ExpoPushToken can send it a notification. That is the whole risk, and it is small here:

- The token only travels from the phone to the user's own instance, over the tailnet or LAN, and is stored in that instance's libSQL. It is never published.
- The worst case is spam notifications to that one device. Push can't read data or reach the instance.
- Expo's 2021 security announcement describes enhanced security as "a second layer of protection" for when tokens leak (cited through search results; [the blog post](https://blog.expo.dev/four-new-security-features-to-protect-your-expo-apps-cdf3e409a1b0) returned 403 to our fetcher).

The real shared-fate risk is the **600/s per-project limit**. Every official-app instance draws from one budget. One buggy instance in a send loop could get the project throttled for everyone. OpenBot traffic is tiny (one owner, a few devices per instance), so this matters only at scale or under abuse. In that case a relay could hold the token and rate-limit per instance, the way Home Assistant caps sends at 500 per device per day.

## What Expo, Apple and Google see

- **Expo:** "Expo doesn't store the contents of push notifications any longer than it takes to deliver them". Contents are kept "only in memory and in message queues, not in databases", but "if the Expo team is actively debugging the push notifications service, we may see notification contents" ([FAQ](https://docs.expo.dev/push-notifications/faq/)).
- **Google (FCM):** "While the connection to FCM is encrypted, it is not end-to-end encrypted. For sensitive data, you should implement your own end-to-end encryption" ([FCM message types](https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type), [FCM E2EE guide](https://firebase.google.com/docs/cloud-messaging/encryption)). Home Assistant tells its users the same: "The contents of the notifications are not encrypted on the Firebase cloud messaging service" ([HA companion docs](https://companion.home-assistant.io/docs/notifications/notification-details/)).
- **Apple (APNs):** sees the payload in the same way. The documented way to hide it is a Notification Service Extension (below).

### Privacy policy for OpenBot payloads

Bot messages can contain anything the user's bots read, including mail, vault-adjacent data and screen content. So:

1. **v1: minimal payload, fetch on open.** `title` = bot or group name, and `body` = a generic line ("New message", "Approval needed", "Routine finished"). `data` = `{chatId, messageId, kind}` only. Use `threadId`/`collapseId` per chat and a short `ttl`. When the user taps, the app loads the content from the instance. This is the same idea ntfy uses for iOS: the upstream gets only the message ID, and the server "literally sends the message `New message` for every message" ([ntfy config](https://docs.ntfy.sh/config/)). The cost is that the lock screen shows no previews.
2. **Later, opt-in previews, end-to-end encrypted.** At registration the phone generates a keypair and gives its public key to the instance (over the private network). The instance encrypts a short preview into `data` and keeps the generic `title`/`body` as the fallback.
   - **iOS:** set `mutableContent: true`. A Notification Service Extension decrypts the preview. It has "only about 30 seconds", and if it doesn't finish, "the system displays the original contents of the notification" ([Apple: Modifying content in newly delivered notifications](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications)).
   - **Android:** FCM's E2EE guide describes the same mutable-content pattern with a generic fallback.
   - This is Nextcloud's model (the subject is encrypted to a device key, so the proxy and Google or Apple can't read it; [Nextcloud push v2](https://github.com/nextcloud/notifications/blob/master/docs/push-v2.md)) and Mastodon's (RFC 8291 Web Push payloads that the relay forwards still encrypted, decrypted in the app's service extension; [webpush-apn-relay](https://github.com/mastodon/webpush-apn-relay)).
   - Cost: expo-notifications documents no Notification Service Extension in its SDK reference, so this needs a custom config plugin and native Swift code in a dev-client build. Defer it.

A fetch from inside the extension (instead of decrypting) would usually fail. The phone often isn't on the tailnet when a push arrives, and the 30-second window is short.

## Alternatives compared

| Option | How it works | Fit for the official app | Fit for self-built |
|---|---|---|---|
| **Expo Push, direct from the instance** (recommended) | The instance POSTs to exp.host with the project's ExpoPushTokens. Expo holds the APNs and FCM credentials uploaded to EAS | Yes. No secrets on the instance; free; one code path | Yes, with the builder's own EAS project |
| **FCM v1 / APNs, direct** | Needs a Firebase service-account JSON plus the project name, or an APNs `.p8` key with its Key ID, Team ID and bundle-ID topic ([Expo: send via FCM/APNs](https://docs.expo.dev/push-notifications/sending-notifications-custom/)) | **No.** These are publisher-owned credentials that can't ship to every instance. Self-hosted apps that use FCM/APNs all put a publisher-run relay in front (below) | Possible, but more work than Expo for no gain |
| **Publisher-run relay** (Home Assistant, Nextcloud, Mastodon) | The instance → an OpenBot relay that holds the credentials → Expo/FCM/APNs. HA's relay is open source ([mobile-apps-fcm-push](https://github.com/home-assistant/mobile-apps-fcm-push)), uses Valkey for rate limiting, and allows 500 pushes per device per day. Nextcloud's proxy verifies a per-user signature on each push | The future upgrade path if the shared limit or abuse needs controlling. A service to run and pay for; not needed in v1 | n/a |
| **ntfy** | Self-hosted ntfy reaches the official iOS app by sending a `poll_request` (message ID plus a hash of the topic) to `upstream-base-url` (ntfy.sh). The app then fetches the message from the user's server. FCM on Android needs your own APK build ([ntfy config](https://docs.ntfy.sh/config/)) | No. It means a dependency on ntfy.sh's relay and its app or protocol, and still needs APNs through someone's credentials. Its fetch-on-open idea is copied anyway | No |
| **UnifiedPush** | The app server sends RFC 8291-encrypted Web Push to a distributor app (ntfy, NextPush, Sunup…) on the phone. "iOS doesn't support running services in the background", so there is **no iOS support** ([UnifiedPush FAQ](https://unifiedpush.org/users/faq/)) | No, because there's no iOS | Maybe later, as an Android-only, Google-free option for de-Googled phones. Out of scope |

How comparable apps do it:

- **Home Assistant:** one official app. Instances send to HA's Firebase-backed relay. Contents aren't stored, there's a cap of 500 per device per day, and it says plainly that FCM isn't E2E.
- **Nextcloud:** one official app. It uses the push proxy `push-notifications.nextcloud.com`, with the subject encrypted to the device and signed by the user's key.
- **Mastodon:** standard Web Push from every server, through a relay to APNs, with the payload still encrypted.
- **ntfy:** the poll-request relay through ntfy.sh, carrying the ID only.
- **Immich:** no sign of a server-to-phone push relay. Searching its issues and code turned up only local, app-side notifications (backup status). It is not a useful precedent.

## Instance-side work this implies (for the PRD)

- **Registration endpoint** in `@openbot/api-contract`: `registerPushDevice({ deviceId, expoPushToken, platform, name })` and `unregister`. Store these in libSQL. Later this gains the device public key for encrypted previews.
- **A send module** using `expo-server-sdk` (with no access token unless `EXPO_ACCESS_TOKEN` is set):
  - Batch up to 100 messages per request, retry 429s and 5xx with backoff.
  - Check receipts after about 15 minutes and drop tokens that report `DeviceNotRegistered`.
- **When to push:** a bot message, approval or question card, or routine result arrives while no SSE client for that device is in the foreground. The webapp's notification settings decide which kinds.
- **Outbound HTTPS to `exp.host`** is required. Instances already need internet access for LLM providers, but the phone itself never needs to reach the instance for the push to arrive.
- **Keep payloads under 4 KB** and generic, as described above. Respect FCM's Android per-device limit of 240 messages per minute and 5,000 per hour, and its collapsible-message limit of a burst of 20 with one refill every 3 minutes ([FCM throttling](https://firebase.google.com/docs/cloud-messaging/throttling-and-quotas)). Use `collapseId` sparingly.
