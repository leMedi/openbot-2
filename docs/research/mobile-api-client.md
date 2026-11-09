# Our oRPC API and SSE stream in React Native

Research for [#84](https://github.com/leMedi/openbot-2/issues/84), under the mobile map [#81](https://github.com/leMedi/openbot-2/issues/81). The question: can the Expo app use `@openbot/api-contract`'s client and the live event stream as they are, and what has to change in the contract or the server?

Done on 2026-11-09. The code read is `main` at `54ca955`: `@orpc/*` 1.16.1 (1.16.2 is the latest), Zod 4. The current Expo SDK is 58 (`expo` 58.0.23), and React Native is 0.88.

## Answer

**Yes, mostly as they are.** On Expo SDK 58, `createApiClient(url)` (an `OpenAPILink` over the global `fetch`) works for every JSON procedure and for the `events` stream, with no polyfill and no Metro config. Nothing in the contract or server *has* to change for the phone.

Four things need mobile-side work, plus one contract change that is recommended but not required:

1. **Sending files.** `chats.send` puts `files` inside an object, so oRPC sends it as multipart, and it only treats something as a file if it passes `instanceof Blob`. Nothing a picker returns on native passes that test. Either install `expo-blob` as the global `Blob`/`File` (this works, but `expo/fetch` buffers the whole form in JS memory), or post that one call outside oRPC with React Native's `XMLHttpRequest` and `{uri, name, type}` parts (recommended).
2. **Downloading files.** Don't go through `chats.attachment` in the oRPC client. Use the plain URLs (`/api` + `attachmentPath(...)`, `pluginIconPath(...)`) with `expo-image` and `expo-file-system`, the same way the webapp uses `<img src>` and `<a href>`.
3. **Lifecycle.** Close the stream when `AppState` goes to `background` and resume it with the last `{epoch, seq}` when it returns to `active`. Add a stall watchdog on top of the server's 5 s keep-alive. The `LiveStore` resume logic itself is unchanged.
4. **Small porting.** `api.ts` takes the instance's address instead of `window.location.origin`. Drafts go through `expo-sqlite`'s `localStorage` instead of the browser's. `LiveStore` is plain TypeScript plus `useSyncExternalStore`, so it ports as-is.
5. **Recommended contract change.** `chats.messages` returns a chat's whole history with no paging. Add cursor paging (`before`, `limit`) before the phone ships, because a resume that can't catch up refetches every open chat in full.

## 1. oRPC client on Hermes and Expo

oRPC's own [Expo adapter page](https://github.com/unnoq/orpc/blob/main/apps/content/docs/adapters/expo.mdx) (rewritten 2026-08-24, last edited 2026-09-12) and [requirements page](https://github.com/unnoq/orpc/blob/main/apps/content/docs/requirements.mdx) are the primary sources here:

- "Expo is the supported way to run oRPC in a React Native app … JSON calls, AsyncIteratorObject, and streamed downloads work in a plain Expo project with no polyfill and no Metro configuration."
- **Web Streams.** oRPC needs `ReadableStream` for every call and `TransformStream` for event iterators. Expo has installed both as native globals since SDK 53.
- **Streaming `fetch`.** React Native's built-in `fetch` is an XHR polyfill with no `response.body`. "From SDK 56 [`expo/fetch`] replaces the global `fetch` on Android and iOS, so there is nothing to wire up."
  - The [SDK 58 `expo` reference](https://docs.expo.dev/versions/latest/sdk/expo/) confirms it: "On Android and iOS, `expo/fetch` is also installed as the global `fetch`." `EXPO_PUBLIC_USE_RN_FETCH=1` opts out of that, and the oRPC page warns that doing so "silently disables streaming". **Never set it.**
  - The source agrees: [`winter/runtime.native.ts`](https://github.com/expo/expo/blob/main/packages/expo/src/winter/runtime.native.ts) installs `fetch`, `TextDecoderStream`, `TextEncoderStream`, `URL`, `URLSearchParams`, `DOMException` and `structuredClone`, and polyfills `Symbol.asyncIterator` for Hermes.
- **Hermes floor.** oRPC uses class static blocks, which Hermes could not parse before React Native 0.78. Every Expo SDK from 53 on is past that.
- **Still missing on native.** There is no `crypto` global, and React Native's `Blob` has no `arrayBuffer()`, `text()` or `stream()`. Neither matters for us except for files (section 4).

I checked our installed client against this list. `@orpc/standard-server-fetch@1.16.1` decodes SSE with `stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventDecoderStream())`, which needs `TextDecoderStream`, and Expo installs it. Nothing else in the client path uses an API that Expo doesn't install.

Two details of `OpenAPILink` matter for the phone:

- **No CORS on native.** The [OpenAPI Link page](https://github.com/unnoq/orpc/blob/main/apps/content/docs/openapi/link.mdx) advises exposing `Content-Disposition` and `Standard-Server` headers to cross-origin browsers. A native `fetch` isn't subject to CORS, so the phone needs no server change even though it is "cross-origin" to the instance.
- **Cookies.** `expo/fetch` defaults `credentials` to `'include'` (see [`fetch.ts`](https://github.com/expo/expo/blob/main/packages/expo/src/winter/fetch/fetch.ts)). That is harmless: ADR 0003 means there are no cookies.

**Use SDK ≥ 58.0.** The [`expo` 58.0.0 changelog](https://github.com/expo/expo/blob/main/packages/expo/CHANGELOG.md) fixes three bugs that would hit a long-lived stream:

- "aborting via an `AbortSignal` now rejects the in-flight read with an `AbortError` instead of hanging forever" (#47573)
- an iOS "streaming race … that could … drop chunks, or leave the body stream open" (#47796)
- iOS `text()` and `arrayBuffer()` never settling after a network drop (#48230)

Our reconnect loop depends on abort and on errors surfacing (section 3).

### Usage

`createApiClient` already takes a full URL, so the phone passes the stored instance address:

```ts
// apps/mobile: lib/api.ts
let client: ApiClient | undefined
export const api = () => (client ??= createApiClient(new URL('/api', instance.address).href))
// "Change instance" resets `client` and the LiveStore.
```

Plain `http://` to a LAN or Tailscale address needs cleartext allowances (iOS ATS, Android `usesCleartextTraffic`). That belongs to the networking research, not this ticket.

## 2. TanStack Query on React Native

TanStack Query is pure JS and runs on React Native. The [React Native guide](https://tanstack.com/query/latest/docs/framework/react/react-native) lists three adaptations:

- `onlineManager.setEventListener` fed by NetInfo or `expo-network` (`Network.addNetworkStateListener`)
- `focusManager.setFocused(status === 'active')` driven by `AppState`, because there is no `window` focus
- `useFocusEffect` for refetch-on-screen-focus, and `subscribed: isFocused` to mute queries on screens that are not focused

`@orpc/tanstack-query` ([docs](https://github.com/unnoq/orpc/blob/main/apps/content/docs/integrations/tanstack-query.mdx)) is also plain JS. Its `liveOptions`/`streamedOptions` work over the same event iterator.

**Finding:** `docs/design.md` §API says "TanStack Query on web and mobile", but **the webapp doesn't use TanStack Query at all**. There's no `@tanstack/react-query` dependency. Live state is the hand-written `LiveStore` (`apps/webapp/src/lib/live.tsx`), and panes call `api()` directly.

The phone should follow the webapp: port `LiveStore` for bots, chats, sections and messages. Using TanStack Query for the non-live panes (Memory, Audit, Routines, Plugins, Settings) is optional and gets the RN focus and online wiring above for free. Whether to share `LiveStore` as a package belongs to the map's "code sharing" item. `design.md` should be corrected either way.

## 3. The `{epoch, seq}` stream across background, suspend and resume

### How it works today

`contract.events` is `GET /events?epoch&seq` returning `eventIterator(stampedEvent)`.

On the server (`router.ts` `events` and `packages/core/src/events.ts` `EventBus`):

- It resumes only if `epoch` matches and `bus.canResume(seq)`. The bus keeps the **last 1000 events in memory**.
- It subscribes first and then yields `hello {resumed}`, followed by the missed events.
- A new epoch (after a server restart) or a client too far behind gets `resumed: false`.

On the client, `LiveStore.run` loops: call `api().events(stamp, {signal})`, `for await` the events, wait 1 s after an error, then reconnect. `#apply` drops duplicates (`seq <= stamp.seq` in the same epoch). On `hello {resumed:false}` it refetches bots, chats, sections and the messages of every chat opened so far, and only then takes the new stamp.

`OpenAPIHandler` in `@orpc/standard-server-fetch@1.16.1` sends an SSE keep-alive comment **every 5 s by default** (`eventIteratorKeepAliveInterval ?? 5e3`), and `http.ts` doesn't override it.

### What the OS does

- **iOS** ([TN2277](https://developer.apple.com/library/archive/technotes/tn2277/_index.html)): "while the app is suspended the system may choose to reclaim resources out from underneath a network socket … thereby closing the network connection". The Apple-recommended pattern for a cheap-to-reopen connection is to close it on background and reopen it on foreground. Otherwise you must handle the error that a reclaimed socket raises on resume.
- **React Native** ([AppState](https://reactnative.dev/docs/appstate)): the states are `active`, `background`, and `inactive` on iOS. iOS reports `inactive` for the multitasking view, Notification Center and calls, so don't tear down on `inactive`.
- **Android** gives no promise that a backgrounded process keeps its sockets. Treat it the same as iOS.

### What mobile does

The server needs no change. The phone needs about 30 lines around `LiveStore.run`:

1. **Close on `background`.** Abort the stream's `AbortController` when `AppState` becomes `background`. This is the TN2277 "close on background" path. The server's handler sees `signal` abort and its `finally` unsubscribes from the bus. Keep `#stamp`.
2. **Resume on `active`.** Start `run()` again. It reconnects with the kept stamp: a short absence replays the gap, and a long one or a restart gets `resumed:false` and a refetch. This is exactly the web path. A dropped connection is the normal case, so there's nothing new to reconcile.
3. **Stall watchdog.** A connection that dies without an error (a Wi-Fi→cellular switch, Tailscale re-keying, a resume on a reclaimed socket) may not surface at once. The keep-alive comments are swallowed by the SSE decoder, so watch bytes instead: pass `OpenAPILink` a custom `fetch` that wraps `response.body` in a `TransformStream`, resets a timer on every chunk, and aborts if nothing arrives for about 15 s (3 keep-alives). Also restart on NetInfo/`expo-network` connectivity changes.
4. **Optional: persist the stamp.** Persist it with the offline cache that #81 already plans (cached chats read-only). A cold start within the same epoch and the 1000-event window can then resume instead of refetching.

Two costs follow from the current design and are worth knowing:

- **Long backgrounds always refetch.** Being away for hours, or across an instance update (which is a restart and therefore a new epoch), always means `resumed:false`. That is fine, because a refetch is the designed fallback.
- **The refetch grows on the phone.** `#refetch` reloads every chat in `this.messages`, meaning every chat opened in this session, and `chats.messages` has **no paging**. That's tolerable on a desktop browser, but on a phone over Tailscale/cellular it grows with use. Evict closed chats from `messages` on mobile, and add paging (next section).

## 4. Attachments

### Upload: `chats.send`

The contract is `POST /chats/{chatId}/messages` with input `{chatId, text, files: z.array(z.file().max(50 MB)).max(6)}`.

- **How oRPC decides "this is a file."** In `@orpc/openapi-client@1.16.1`'s serializer, the body becomes `FormData` only if a value is `instanceof Blob`. Each part is then appended under a bracket-notation key: `text`, `files[0]`, `files[1]`, and so on ([bracket notation](https://github.com/unnoq/orpc/blob/main/apps/content/docs/openapi/bracket-notation.mdx)). Anything else is serialized as JSON.
- **Nothing on native passes that check.** An image-picker result is `{uri: 'file://…', fileName, mimeType, fileSize}`. `asset.file` is web-only ([ImagePicker](https://docs.expo.dev/versions/latest/sdk/imagepicker/)). `expo-file-system`'s `File` "implements Blob" ([FileSystem](https://docs.expo.dev/versions/latest/sdk/filesystem/)) but doesn't extend the global `Blob`, as Expo's own [`convertFormData.ts`](https://github.com/expo/expo/blob/main/packages/expo/src/winter/fetch/convertFormData.ts) says ("File or ExpoBlob don't extend Blob but implement the interface"). Passed through the oRPC client as-is, files become JSON and the server's `z.file()` rejects them.

There are two working routes.

| | A. `expo-blob` polyfill, keep `api().chats.send` | B. Bypass oRPC for this one call (**recommended**) |
|---|---|---|
| How | Install `expo-blob` as `globalThis.Blob` plus a `File` subclass. oRPC's Expo page lists "Nested `File` or `Blob` upload, Fetch: 🟡 with the Blob polyfill". | React Native's `XMLHttpRequest` + `FormData` with `{uri, name, type}` parts under keys `text` and `files[0..5]`, posted to `/api/chats/{chatId}/messages`, with the response parsed by the contract's `message` schema. |
| Memory | `expo/fetch` reads every part into JS and joins them into one `Uint8Array` before sending ([`convertFormData.ts`](https://github.com/expo/expo/blob/main/packages/expo/src/winter/fetch/convertFormData.ts): "`uri` is not supported"; [`RequestUtils.ts`](https://github.com/expo/expo/blob/main/packages/expo/src/winter/fetch/RequestUtils.ts) buffers streams too). With 6 × 50 MB that can reach hundreds of MB in Hermes. | React Native's [`FormData.getParts`](https://github.com/facebook/react-native/blob/main/packages/react-native/Libraries/Network/FormData.js) passes a part with a `uri` to the native networking layer, which reads the file from disk. No bytes go through JS. |
| Progress | None (`fetch` has no upload progress) | `xhr.upload.onprogress` |
| Side effects | Replacing the global `Blob` breaks `URL.createObjectURL`, `FileReader`, and XHR/WebSocket `'blob'` results (oRPC's warning) | None. The rest of the app keeps the oRPC client. |
| Type safety | Full | Input is hand-built. Output is validated with `message.parse`. Covered by one contract test. |

Expo's `FormData` patch keeps the `{uri, name, type}` overload ([`winter/FormData.ts`](https://github.com/expo/expo/blob/main/packages/expo/src/winter/FormData.ts)). Route B goes through XHR on purpose, because the global `fetch` is now `expo/fetch`, which rejects `uri` parts.

Use `files[]` or indexed keys. A single bare `files` key deserializes to a single value, not an array.

Image picker notes: pass `shouldDownloadFromNetwork: true` on iOS so iCloud-only photos and Live Photos load. Consider downscaling large camera images before sending (e.g. `expo-image-manipulator`).

`expo-file-system`'s `UploadTask` (multipart, progress, iOS background session) sends **one file per request**, so it can't carry a message with 6 files under the current contract.

### Download: `chats.attachment` and the plugin icon

`chats.attachment` is `outputStructure: 'detailed'` with `body: z.file()`, which is a root-level file download. oRPC's table marks that "🟡 with the Blob polyfill" on Expo.

Don't use the client for it at all. The webapp doesn't either: `components/attachments.tsx` builds `` `/api${attachmentPath(messageId, id)}` `` and uses it as a URL. With no auth (ADR 0003) a plain URL is enough:

- images: `<Image source={{ uri }} />` from `expo-image`, with its disk cache
- other files: `File.downloadFileAsync(url, dir)` or `File.createDownloadTask` from `expo-file-system`, then `expo-sharing` or Quick Look to open them
- plugin icons: the same, via `pluginIconPath(name)`

No contract change is needed.

## 5. What changes, by owner

**Contract or server**

- **Required:** none.
- **Recommended:** cursor paging on `chats.messages` (`before?: messageId`, `limit`), with the newest page first. The phone loads the latest page and pulls older pages on scroll, and a `resumed:false` refetch only reloads the latest page of each open chat. The webapp can adopt it later.
- **Optional, later:** a per-file upload endpoint (e.g. `POST /chats/{chatId}/uploads`, raw body as a root-level `File`) returning an upload id, plus `send({text, uploadIds})`. That allows `expo-file-system` native or iOS background uploads, per-file retry and progress. It's only worth doing if sending large files from the phone turns out to be common. Route B covers v1.
- **Already there:** `health` returns `{epoch, version}`, a ready-made base for the "API version endpoint" #81 mentions for compatibility checks.

**Mobile app**

- Expo SDK ≥ 58. Never set `EXPO_PUBLIC_USE_RN_FETCH`.
- `api()` from the stored instance address.
- Port `LiveStore`, then add the `AppState` close and resume, the stall watchdog, connectivity restarts, and eviction of closed chats.
- Drafts via `import 'expo-sqlite/localStorage/install'` ([SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/)), so `LiveStore`'s `Storage` parameter works unchanged.
- Upload route B. Attachment and icon URLs via `expo-image` and `expo-file-system`.
- TanStack Query only for the non-live panes, if at all, with `focusManager` and `onlineManager` wired as in its RN guide.

**Docs**

- `design.md` §API claims TanStack Query on web, but the webapp doesn't use it.

## Not covered here

- The screen's VNC WebSocket (`screens.ticket`), which belongs with the Screen / take-over work.
- Cleartext HTTP, Tailscale and LAN reachability: the networking research.
- Push notifications while the stream is closed in the background: a separate ticket.
