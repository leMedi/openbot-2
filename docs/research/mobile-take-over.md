# Taking over a bot's Screen by touch

Research for [#85](https://github.com/leMedi/openbot-2/issues/85), a child of the mobile map [#81](https://github.com/leMedi/openbot-2/issues/81). The question is how the Expo app should show and control a bot's **Screen**. There are two options: noVNC inside a WebView, or a native VNC client library. Sources were read on 2026-11-09. They include noVNC `master` (latest release 1.7.0, 28 Apr 2026), the react-native-webview docs, Expo's DOM components guide, and the repos of the native libraries.

## Recommendation

**Run noVNC inside a WebView, through an Expo DOM component (`'use dom'`), and reuse the webapp's `ScreenView` logic.** Build the controls around it in native code: a toolbar with the keyboard, extra keys, zoom/pan and hand back. On mobile data, connect with a lower JPEG quality.

A native VNC client is not viable today, for four reasons:

1. No maintained cross-platform library exists that Expo could wrap.
2. None of the candidates has an iOS view.
3. None of them speaks WebSocket, and the instance only exposes the stream as a WebSocket behind a ticket.
4. Every gesture mapping would have to be rebuilt, when noVNC already ships them.

## What the instance offers today

This section describes `main`. The issue says `/vnc/:botId`, but the code has moved on.

- Each bot's Screen is an Xvfb display at a fixed **1280×800**. It is served by `x11vnc -localhost -forever -shared -nopw -xkb` on `127.0.0.1:5900+N` (`apps/desktopd/src/programs.ts`).
- The webapp first calls `screens.ticket({ botId })`, which returns a single-use ticket valid for 30 s. It then opens a WebSocket to `/api/screens/:botId/stream?ticket=…`. The server bridges that socket byte for byte to x11vnc using `ws` with `perMessageDeflate: false`. When a slow viewer has more than 4 MB buffered, the server pauses the screen (`apps/webapp/src/server/screen-stream.ts`). The stream is raw RFB over WebSocket, with no websockify in between.
- `ScreenView` (`apps/webapp/src/components/screen-pane.tsx`) loads `@novnc/novnc` ^1.7.0 and creates `new RFB(target, url, { shared: true })`. It sets `scaleViewport = true`. It sets `viewOnly = !interactive`: the pane is view-only, and **⤢ Open** gives a fullscreen view that is interactive. It also reconnects after a failure, with a fresh ticket each time.
- **View-only is enforced only on the client** (`docs/design.md`, "Screen pane"). The take-over card and the fullscreen banner hand the Screen back with `chats.handBack({ messageId, outcome })` (`take-over-card.tsx`).

The phone can use the same API: get a ticket, open the WebSocket, and speak RFB over it.

## Option A: noVNC in a WebView

### Touch-to-mouse mapping is already built in

noVNC's `RFB` has its own gesture handler (`core/input/gesturehandler.js`), which `_handleGesture` in `core/rfb.js` turns into RFB pointer events. ([gesturehandler.js](https://github.com/novnc/noVNC/blob/master/core/input/gesturehandler.js), [rfb.js](https://github.com/novnc/noVNC/blob/master/core/rfb.js))

| Gesture | What noVNC sends |
|---|---|
| One-finger tap | Left click (`0x1`). A second tap within 1000 ms and 50 px reuses the first tap's position, so double-clicks land. |
| Two-finger tap | Right click (`0x4`) |
| Three-finger tap | Middle click (`0x2`) |
| Drag | Left button held from the start of the gesture to its end (selecting text, dragging windows) |
| Long press (1000 ms) | Right button held. With `dragViewport`, a press without movement sends a right click. |
| Two-finger drag | Wheel steps every 50 px, vertical (`0x8`/`0x10`) and horizontal (`0x20`/`0x40`) |
| Pinch | Holds **Ctrl** and sends wheel steps every 75 px. This means *zoom in the remote app* (Chrome zooms its page), **not a local zoom**. |

The thresholds (`GH_MOVE_THRESHOLD` 50 px, `GH_LONGPRESS_TIMEOUT` 1000 ms, `GH_MULTITOUCH_TIMEOUT` 250 ms) are constants in the library and cannot be configured.

This covers everything #85 asks for (tap, long-press right click, two-finger scroll, drag) without any of our own code. The webapp already gets it today whenever someone opens the Screen on a touch browser.

### Pinch-zoom and panning on a desktop-sized Screen

- With `scaleViewport`, a 1280×800 Screen on a phone in portrait shrinks to about 0.3× (390 pt / 1280). In landscape it is about 0.5× (about 390 pt tall / 800). Text is hard to read in portrait and barely usable in landscape. Resizing the remote session is not an option, because the bots' computer use depends on 1280×800.
- noVNC has no local zoom. Its own pinch sends Ctrl+wheel to the remote. What it does offer is `clipViewport` with `dragViewport`: the Screen is shown at 1:1, clipped to the container, and a drag pans the view instead of sending a mouse drag. `scaleViewport` turns clipping off, so the two modes are exclusive. ([API.md](https://github.com/novnc/noVNC/blob/master/docs/API.md); `_updateClip` in rfb.js)
- **Proposal:** fullscreen take-over opens in landscape at **fit** (`scaleViewport`). A native **1:1 / Fit** toggle switches to `clipViewport + dragViewport`. While panning in 1:1, drag moves the view, and a tap still clicks. Long press still sends a right click.
- The WebView's own zoom has to be off, or it will fight noVNC for touches. On Android set `scalesPageToFit={false}` and `setBuiltInZoomControls={false}`. On iOS set `scrollEnabled={false}`, `bounces={false}`, and a `user-scalable=no` viewport. ([react-native-webview Reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md))
- The webapp does not use CSS-transform zoom on the canvas (noVNC maps pointer coordinates through its own scale). We should not invent one either. We should only consider it if the 1:1/Fit toggle proves too coarse in a prototype.

### Soft keyboard and special keys

- **The `RFB` library does not raise a soft keyboard.** The noVNC *app* does that (`app/ui.js`): it keeps a hidden `<input id="noVNC_keyboardinput">` filled with placeholder characters, then focuses it to bring up the native keyboard. On `input`, it diffs the field's value and turns the difference into `rfb.sendKey` calls (backspaces become `XK_BackSpace`, and each character is looked up as a keysym). A blur followed by a refocus works around Android's IME. It also sets `rfb.focusOnClick = false` while the keyboard is up. The extra-keys bar has Esc and Tab, latching Ctrl, Alt and Super toggles that send key-down and key-up, and Ctrl+Alt+Del. ([ui.js](https://github.com/novnc/noVNC/blob/master/app/ui.js))
- **We copy that pattern into the DOM component**, about 60 lines. The keyboard button lives in the native toolbar and calls into the DOM component through `useDOMImperativeHandle`. iOS needs `keyboardDisplayRequiresUserAction={false}`, or WKWebView refuses to focus the input from script. `hideKeyboardAccessoryView` removes the "< > Done" bar. ([react-native-webview Reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md))
- Special keys are sent from the native toolbar with `rfb.sendKey(keysym, code, down)`: Esc, Tab, Ctrl/Alt latches, arrows, Enter. Pasting goes through `rfb.clipboardPasteFrom(text)`, which only fills the remote clipboard. To type a whole password into a login form, we iterate over the text with `sendKey`, as `keyInput` does. ([API.md](https://github.com/novnc/noVNC/blob/master/docs/API.md))

### View-only mode

`viewOnly` is a single flag on `RFB`. Use it for the inline preview, exactly as on the web. As on the web, this is client-side only (ADR 0003: private network, no auth).

### Performance on mobile data

- noVNC requests Tight/JPEG through `qualityLevel` (0–9, default 6) and `compressionLevel` (0–9, default 2). Both can be changed while connected. ([API.md](https://github.com/novnc/noVNC/blob/master/docs/API.md)) x11vnc supports Tight and ZRLE when built with libjpeg and zlib, and Debian's package is ([x11vnc README](https://github.com/LibVNC/x11vnc/blob/master/README)).
- **Proposal:** use the defaults on Wi-Fi. On cellular (expo-network's connection type), use `qualityLevel` around 3 and `compressionLevel` around 6. Keep the preview pane disconnected unless it is on screen. The server's 4 MB back-pressure already protects the instance from a slow phone.
- The WebSocket goes over the tailnet or the LAN, the same path as the rest of the API, so the networking research (a sibling ticket under #81) applies unchanged. That covers cleartext HTTP/WS on a private address under iOS ATS and Android's cleartext policy.
- The WebView adds startup cost (DOM components run plain JS, not Hermes bytecode) and an async JSON bridge. Neither matters here, because the pixels never cross the bridge: noVNC talks to the instance directly. Only toolbar commands and state events (connected, disconnected, unreachable) cross. ([Expo DOM components](https://docs.expo.dev/guides/dom-components/))

### Expo DOM components fit well

- On SDK 56 and later, a `'use dom'` component renders in `@expo/dom-webview` by default. `dom={{ useExpoDOMWebView: false }}` falls back to `react-native-webview`, which exposes the keyboard props above. Props are marshalled asynchronously. Native actions are async top-level function props. `useDOMImperativeHandle` lets native code call into the component. ([Expo DOM components](https://docs.expo.dev/guides/dom-components/))
- That fits the split exactly. `ScreenView` (ticket, RFB, reconnect, states) moves into a shared module that the webapp and the mobile DOM component both import. The native side gets the ticket URL (or an async `getTicket` action), `interactive`, and quality, and it calls `showKeyboard`, `sendKey`, `setZoom` and `disconnect`.
- Check before building: whether `@expo/dom-webview` supports `keyboardDisplayRequiresUserAction` on iOS. If it does not, use `useExpoDOMWebView: false` for this one component.

## Option B: a native VNC client library

| Library | Platforms | License | State | Problems for us |
|---|---|---|---|---|
| [RoyalVNC / RoyalVNCKit](https://github.com/royalapplications/royalvnc) (Swift, with Kotlin bindings) | macOS, iOS, Android, Linux, Windows | MIT | **Archived 5 Oct 2026**, read-only. No releases. | The ready view is a macOS `NSView`, and the iOS `UIView` "is a work-in-progress". No touch handling. No WebSocket transport. Android setup only builds on macOS. |
| [LibVNCClient](https://github.com/LibVNC/libvncserver) (C) | Cross-platform | GPL-2.0 | Maintained | GPL would apply to the app. No UI and no touch handling. TCP only, so a WebSocket shim is needed. Needs an NDK and iOS build per platform. |
| [AVNC](https://github.com/gujjwal00/avnc) (Kotlin app on a libvncserver fork) | Android only | GPL-3.0 | Active app (3.2.2) | An app, not a library. GPL-3.0. No iOS. |
| React Native / Expo VNC packages | — | — | None found on npm. `react-vnc` is a React DOM wrapper around noVNC. | — |

To go native, we would have to write an Expo module on each platform. Each one would need four things:

- an RFB client with a WebSocket transport, because the instance only exposes `/api/screens/:botId/stream` as a WebSocket with a ticket, and the VNC ports are localhost-only by design
- a Tight/JPEG decoder rendering into a native view
- our own gesture recognizer with the same mapping noVNC already has
- our own keyboard plumbing

In return we would get smoother pinch-zoom (a native scroll view around the framebuffer) and slightly better decode performance. That is not worth two native clients, an archived or GPL dependency, and a diverged implementation from the webapp.

## Open points for the spec

- **Landscape:** should fullscreen take-over force landscape (`expo-screen-orientation`) or only suggest it? Fit in landscape is about 0.5×, which is usable for clicking but not for reading small text without 1:1.
- **Local zoom:** is the 1:1/Fit toggle enough, or does a prototype show that true pinch-to-zoom is needed? If it is, the cheapest route is a CSS transform on the noVNC container, which needs pointer coordinates corrected. That is unverified.
- **Who has control:** the web and phone viewers are both `shared: true`, so both can type at once. Nothing new here for mobile. Take-over has no lock today (as in Grok).
