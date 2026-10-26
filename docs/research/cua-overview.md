# Cua: Spaces, cua-driver and the Linux images

These notes come from reading the [`trycua/cua`](https://github.com/trycua/cua) monorepo and the locally installed Cua Spaces app. The repo was cloned on 2026-10-25, when cua-driver was at 0.38.0 and the Spaces tool contract was at 0.7.0.

## How the pieces fit

```
Cua Spaces app (SwiftUI on macOS / Electron / Tauri)
        │  all share one Rust core (libs/cua/crates/cua-spaces-app-core)
`cua` CLI + `cua daemon`  ── ~/.cua/cua.sock, serves the Spaces MCP server (96 tools)
        │  gRPC / WebSocket / QUIC, directly, through a WireGuard mesh, or through relay.cua.ai
cua-spacesd  ── a daemon inside every Space, port 3211 (+3212/udp for video)
        │  has cua-driver built in
cua-driver  ── operates real GUI apps through the OS accessibility APIs
```

Key places in the repo:

| Path | What it holds |
|---|---|
| `apps/cua-spaces-macos`, `apps/cua-spaces`, `apps/cua-spaces-desktop`, `apps/cua-spaces-web` | The apps |
| `libs/cua` | CLI, daemon, SDK and the Spaces MCP server; the tool contract is `libs/cua/spaces-contract/manifest.json` |
| `libs/cua-spacesd` | The daemon that runs inside a Space, and the relay |
| `libs/cua-driver` | GUI automation runtime |
| `libs/images` | Space images |

---

## 1. Cua Spaces

A **Space** is one isolated desktop. It can be a container, a VM, or a real machine's own desktop. Cua no longer rents machines: the docs say "Cua Cloud has ended". Spaces run on your Mac, on your other machines, or in your own cloud account.

### Where Spaces run

**On your Mac:**
- **Lume** (Apple's Virtualization.framework) runs macOS and Linux arm64 VMs.
- **QEMU** runs Linux and Windows VMs.
- **Docker** runs Linux containers, preferring gVisor (`runsc`) for stronger isolation and falling back to runc. If you have no Docker, a built-in managed Linux VM is used instead.
- **Cua's own microVMs.**
  - `cua-vz` is a VM monitor built on Virtualization.framework, one process per VM.
  - `cua-microvm-init` is the small init process (PID 1) that starts the guest.
  - The first boot of each configuration is snapshotted. Later starts restore that snapshot and then get a fresh identity (token, hostname, machine id).
  - Paused pools can be claimed in a fraction of a second. `prewarm` and `sandbox_pool_*` build on this.
- **Apple Containerization** (macOS 26) can also run Linux containers.

**In your own cloud account:**
- `aws` and `gcp` give one VM per Space, with Docker running the image.
- `hetzner` runs containers only.
- `modal` uses Modal sandboxes.
- Every resource is tagged `cua-managed=true`. `cloud_budget` sets spending caps, and `cloud_sweep` deletes only resources Cua tagged (it defaults to a dry run).

**On your own machines:**
- `cua host setup` turns a machine such as a Mac mini on Tailscale into a Space host.
- That machine dials out to the relay, so no inbound port is needed. You then create Spaces on it with `on="host:<name>"`.

### Features

| Area | What it does |
|---|---|
| Lifecycle | Create, reuse (get-or-create), start/stop, delete. A `durable` Space is recreated on another of your machines if its host goes away. |
| Commands and files | `space_bash` and `space_write`. Upload and download are sha256-checked. `send_file` drops a file into the Space's Downloads, resumes if interrupted and honors `.gitignore`. |
| Watching | Live video of the desktop or one window: H.264 + Opus over WebSocket or QUIC. This is Cua's own protocol ("rcdp wire v2"), not WebRTC. Also picture-in-picture on your screen, a full viewer, and an HTML5 viewer at `/viewer`. |
| Computer use | `computer_*` tools (screenshot, click, type, accessibility tree, windows, clipboard, files), backed by cua-driver inside the Space. |
| Coding agents | `agent_start` installs a harness from pinned, checksum-verified sources and drives it over ACP (Agent Client Protocol). Harnesses: Claude Code, Codex, Gemini CLI, OpenCode, Goose, Pi, Hermes, OpenClaw and others. Runs keep going if your client disconnects. |
| Persistent agents and routines | A named agent keeps its memory in Cua Volume at `agents/<name>/`. Routines are scheduled turns that the daemon fires even when the app is closed. `notify_user` posts to the app's notification feed. |
| Teleport | Moves a signed-in app session (Chrome cookies, Slack, VS Code, Claude Code…) from your Mac into a Space after you approve with Touch ID. Chrome cookies are decrypted on your Mac and re-encrypted under the Space's own key. |
| Keyvault | An encrypted local vault. `request_site_login` types a password into the exact web page through the driver and never returns it to the agent. Google, Microsoft, Apple and Okta logins are never unlocked for unattended use. |
| Hotspot | Gives a Space your Mac's network (VPN or intranet) through a SOCKS5 tunnel. |
| Cua Volume | One versioned drive per account, synced everywhere. It is mounted at `/volume` on Linux and `~/Cua Volume` on macOS, and can be backed by local storage, S3 or R2. Layout: `public/`, `agents/<name>/`, `spaces/<name>/`. Writes under `agents/` are scanned for secrets. |
| Sharing | Share a Space with a teammate as viewer or editor. Create private, team or time-limited public links to a port or a file. |
| Batch runs | `space_run(s)`: a durable job queue across your machines. |
| Skills | Record a demonstration in the viewer. It becomes a `SKILL.md` plus captioned frames under `~/.cua/skills/<name>/`. |

### Security

- **Tokens:** every cua-spacesd needs a token, compared in constant time. Video, tunnels, files and the volume use short-lived tickets or signed URLs derived from that token.
- **Network paths:** connections prefer a WireGuard mesh with hole punching. The relay's HTTPS fallback terminates TLS and can read traffic in flight; setting `CUA_MESH=require` disables that fallback.
- **Approvals:** Keyvault use, teleport, Volume grants and computer access grants need Touch ID, your login password or a passphrase.
- **Audit logs:** Volume, Keyvault, hosts and cloud actions each keep a tamper-evident (hash-chained) log.
- **MCP permissions:** `--permissions` / `CUA_MCP_PERMISSIONS` scope what an MCP client may call, for example `spaces:readonly`.

---

## 2. cua-driver

cua-driver is a Rust runtime (`libs/cua-driver`) that lets an agent **operate native apps in the background**. It does not raise windows, move your real mouse pointer or change the frontmost app.

It ships as one binary with several roles:
- an MCP server: `cua-driver mcp`
- a CLI: `cua-driver <tool> '<json>'`
- a daemon: `cua-driver serve`
- Python and TypeScript SDKs: `pip install cua-driver`, `@trycua/cua-driver`

### How an agent uses it: observe, act once, verify

1. **Observe.** `get_window_state` returns the accessibility tree together with a screenshot.
2. **Act.** Elements are referenced by tokens like `s1a2b3c4:7`. A new snapshot invalidates the old tokens, so an agent can't act on stale UI.
3. **Read the result.** Every action reports:
   - how it was delivered (`path`)
   - whether it was verified through accessibility (`verified`)
   - its effect: `confirmed`, `unverifiable`, `suspected_noop`, `partial` or `refused`
   - which fallback to try next when it fails (`escalation`)
4. **Fall back if needed.** The order is: element in the background, then pixel in the background, then the browser page via CDP, then bringing the window to the front.
5. **Verify.** `verify_state` checks up to 8 conditions (window exists, element value, enabled, selected…) and can poll until they hold. "unknown" never counts as success.

### Tools

- **Apps and windows:** `list_apps`, `list_windows`, `launch_app`, `invoke_menu` (exact menu path), `set_window_frame`.
- **Input:** click, drag, scroll, `type_text`, hotkeys, `set_value`, clipboard.
- **Batching:**
  - `run_steps`: up to 64 steps per call, stopping at the first failure.
  - `run_script`: sandboxed JavaScript (QuickJS) with a `cua.*` API.
- **Browser:** `browser_*` tools drive Chrome or Edge over CDP. They use an isolated profile, or your logged-in profile only if you explicitly allow it.
- **Recording:** record action trajectories (before/after state, screenshots, optional MP4) and replay them.
- **History:** an opt-in, encrypted, metadata-only action history, read with `history_status` and `history_query`.
- **Agent cursors:** several cursors in different colours. Sessions are separate, but they share one screen, keyboard and focus.

### How it works on each OS

**macOS**
- Uses the Accessibility API.
- Background input goes through a private SkyLight call, `SLEventPostToPid`, which Chromium apps also accept.
- ScreenCaptureKit captures windows.
- Needs the Accessibility and Screen Recording permissions.

**Windows**
- Uses UI Automation, falling back to MSAA.
- Sends window messages to the target window.
- Windows.Graphics.Capture captures windows.

**Linux**
- Uses AT-SPI with X11/XTest; X11 is fully supported.
- Wayland is opt-in with `CUA_DRIVER_RS_ENABLE_WAYLAND=1`:

| Wayland desktop | Status |
|---|---|
| Sway | Supported with limits |
| GNOME | Supported with limits; needs a shell extension |
| KDE | Experimental |
| Hyprland | Experimental (plugin) |

### Permissions and embedding

- **Three modes:**
  - `standard`, the default
  - `bounded`, limited by a YAML manifest of allowed tools, apps, files and browser origins
  - `unrestricted`, which needs `--dangerously-bypass-approvals`
- **Policy files:** admin and user policy in YAML or Rego. Each layer can only narrow what the agent may do.
- **Embedding:** it can run inside your own signed app (`CUA_DRIVER_EMBEDDED=1`) and inherit that app's macOS permissions.
- **MCP over HTTP:** optional and loopback only, enabled with `CUA_DRIVER_RS_MCP_HTTP_PORT` plus a bearer token.

---

## 3. Linux Docker images

### `ghcr.io/trycua/linux:24.04`: the main Space image

It is built for amd64 and arm64. The same Dockerfile produces both a container and a bootable VM disk (the `-disk` tags). Sources: `libs/images/linux/Dockerfile` and `libs/images/sandbox-images.json`.

**Desktop**
- Ubuntu 24.04 with XFCE on a virtual display (Xvfb `:1`, 1280×800).
- There is no VNC. cua-spacesd streams the screen itself and serves a web viewer at `:3211/viewer/`.

**Audio:** PipeWire with a virtual speaker and a virtual mic.

**For agents:** cua-spacesd on port 3211 serves:
- gRPC
- an MCP endpoint at `/mcp`, with cua-driver built in
- `/files`
- tunnels
- hotspot
- media

Video also uses 3212/udp. AT-SPI is on so the driver can read the accessibility tree.

**Browser:** Chromium with sign-in, sync and the password manager turned off. Agents drive it over CDP.

**Cua Volume:** mounted at `/volume`. It works under gVisor or in a VM; a plain local runc container has no `/dev/fuse`, so it does not work there.

**User and processes:** user `cua` (uid 1000) with passwordless sudo, running under supervisord. If you don't pass `CUA_ENV_TOKEN`, a token is generated automatically.

**Tiers**

| Tag | Adds |
|---|---|
| `24.04-slim` | The minimum: desktop, Chromium, cua-spacesd |
| `24.04` (default) | Firefox, build-essential, git, Node 24 + pnpm, Go, Rust, uv, gh, ripgrep, Docker CLI |
| `24.04-docker-disk` | A full Docker engine inside a VM, so `cua sb bake` can snapshot a running Compose stack and start forks from it. The docs say it isn't published yet. |

No coding agents are baked in; `agent_start` installs them when needed.

**Running it**
- Usually through the CLI: `cua sb create linux`, or `create_space(on="local")`.
- To run it by hand (inferred, not documented verbatim): `docker run -p 3211:3211 -p 3212:3212/udp -e CUA_ENV_TOKEN=... ghcr.io/trycua/linux:24.04`

### Other images

| Image | What it is |
|---|---|
| `ghcr.io/trycua/omarchy:edge` | Arch Linux with Hyprland (Wayland). VM only, amd64 only. Shows computer use on a Wayland compositor. |
| `ghcr.io/trycua/bench-web` | Chromium with CDP on 9222, a control API on 7000 and MiniWoB++ on 7560, for web-agent benchmarks |
| `ghcr.io/trycua/bench-osworld` | The OSWorld Ubuntu GNOME VM with cua-spacesd added |
| `ghcr.io/trycua/runtime-gvisor` | Not a Space. It is the hidden Linux VM a Mac uses to run Linux Spaces when Docker isn't installed, with gVisor as its default runtime. |
| `trycua/cua-xfce`, `trycua/xfce-cua` (Docker Hub, older) | XFCE with VNC and a browser viewer (noVNC) on 6901 |
| `trycua/cua-ubuntu` (Docker Hub, older) | KasmVNC web desktop |
| `trycua/cua-qemu-linux`, `-windows`, `-android` (Docker Hub, older) | A full VM running inside a container. Linux and Windows need KVM; Android is an emulator driven over ADB. |

The Docker Hub images are an older generation and simpler; prefer the GHCR images.

### What the images let you do

- isolated desktops for computer-use agents
- browser automation over CDP
- coding agents in a sandbox
- benchmarks (OSWorld, MiniWoB++)
- a desktop you can watch live, with audio
- files that persist across Spaces through Cua Volume

---

## Where the code and docs disagree

- The README says the Linux image includes Firefox, but only the full tier has it; slim ships Chromium only.
- `sandbox-images.json` says `windows:2022` includes cua-spacesd, but the images README says it doesn't.
- The cua-driver README says it drives macOS apps, but the code covers macOS, Windows and Linux.
- `libs/cua/README.md` says the Spaces MCP server has 33 tools; the contract has 96.
- `libs/fleet` appears to be the former hosted cloud, which has been shut down.

## Relevance to openbot

- `agent_start` and persistent agents can run coding agents inside a sandbox.
- `ghcr.io/trycua/linux:24.04` can serve as a disposable workspace for each agent.
- cua-driver's MCP server can give agents GUI control.
- Cua Volume can hold agent memory and outputs that outlive a single Space.
