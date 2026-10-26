# Grok Bot: architecture and internal mechanics

Paths are relative to `grok-bot-0.18-reconstructed-main/source/`. The internal codename is **sand**.

## 0. The big idea

Grok Bot is a **thin desktop client for a per-user cloud VM**. The agent brain is the **host** (`host-main.cjs`). It runs **inside the VM** and exposes an HTTP + SSE "gateway". The desktop runs four things:

1. **Electron main.** Handles login, secrets, settings and the VM connector, and launches and supervises the other processes.
2. **The coordinator.** A Node utility process that proxies renderer requests to the VM gateway and fans VM events back out.
3. **The renderer.** The React UI.
4. **The local-exec daemon.** A detached process that lets the agent in the VM run commands on the user's own Mac. It works by *long-polling the VM*.

Everything server-side goes through **Cursor's backend** (`api2.cursor.sh`, Connect RPC with protobuf, `aiserver.v1.*`): auth, VM brokering, inference, analytics, flags and updates. **No xAI endpoint appears anywhere.** Grok models are served via Cursor's `InferenceService.Stream`.

Because the agent lives in the VM, it **keeps working when your laptop is closed**. Routines, background shells, subagents and multi-agent groups all live there.

---

## 1. Process topology

```
┌──────────────────────────── Desktop (macOS / Windows) ─────────────────────────────┐
│                                                                                     │
│  Electron MAIN  (electron-main/main.ts)                                             │
│   • Cursor PKCE login, safeStorage secrets, settings.json                           │
│   • VM connector: GrokBotService.EnsureSandBox → {gatewayUrl, token, vncUrl}        │
│   • desktop MCP manager (plugins/OAuth), updater, Sentry, Statsig                   │
│   • OS notifications, dock badge                                                    │
│        │ utilityProcess.fork + 3 MessageChannels [control, renderer-data, main-data]│
│        ▼                                                                            │
│  node-agent-coordinator (utility process)                                           │
│   • renderer-port-server ◄──────── MessagePort ──────── Renderer (React UI)         │
│   • CoordinatorGatewayClient: POST /api/<cmd>, SSE GET /events                      │
│   • SandHostSupervisor (health/connection cache)                                    │
│   • LocalExecDaemonSupervisor, WebAuthn bridge, MCP OAuth forwarder                 │
│        │ asks main to spawn                                                         │
│        ▼                                                                            │
│  local-exec-daemon (detached; survives app quit)                                    │
│   • SSE GET /local-exec/requests  ←─ the VM asks for commands                       │
│   • POST /local-exec/responses    ─→ results back                                   │
│   • shell-exec (bash/zsh, optional macOS seatbelt sandbox)                          │
│                                                                                     │
│  egress-tunnel exit client (WebSocket → VM :8790)                                   │
└──────────────────────────────────────┬──────────────────────────────────────────────┘
                                       │ HTTPS  Bearer gatewayToken + x-anyrun-network-token
                                       │ (Cursor "anyrun" pod proxy in front of the VM)
┌──────────────────────────── The box (cloud Linux VM) ───────────────────────────────┐
│  sand-host  (host/main.ts → host/sand-host.ts)                                      │
│   • gateway :1340  /api/* (~129 commands), /events (17 SSE channels), /health,      │
│     /avatars, /local-exec/*, /webauthn/*, /prepare-upgrade                          │
│   • 35 host extensions (transcript, session, inference, memory, mcp, automations…)  │
│   • SandAgentRunner → AnysphereAgent → Cursor InferenceService.Stream               │
│        │ Connect RPC agent.v1.ExecService / ControlService                          │
│        ▼                                                                            │
│  box exec daemon 127.0.0.1:1337 (shell/read/background shells)                      │
│  X desktop + Chrome (persistent profile) + noVNC 6080 (primary) / 6081 (per-agent)  │
│  supervisor (/tmp/sand-supervisor) for host self-upgrade                            │
│  data: /home/box/sand-data (model sees /home/box/agent-data)                        │
└──────────────────────────────────────┬──────────────────────────────────────────────┘
                                       │ box-store-sync → S3 (presigned via api2)
                                       ▼
                              Cursor backend api2.cursor.sh
        (GrokBotService, InferenceService, AiService, DashboardService, AutomationsService,
         BackgroundComposerService (cloud agents), AnalyticsService, notify-bus stream)
```

### 1.1 Electron main ↔ coordinator

- **Launch.** `launchCoordinator` (`electron-main/coordinator/coordinator-launcher.ts:46`) forks `node-agent-coordinator/main.cjs` as an Electron `utilityProcess`. It creates three `MessageChannelMain`s and posts `{bootstrap:{processConfig}}` along with the ports:
  - **control**: the coordinator calls main for things only main can do.
  - **renderer-data**: transferred to the renderer.
  - **main-data**: a restricted method subset for main.
- **Frame protocol** (`shared/rpc/coordinator-port.ts`, protocol version 1):
  ```
  {kind:"lifecycle", phase:"hello"|"ready"|"shutdown"}
  {kind:"request",  requestId, method, args}
  {kind:"cancel",   requestId}
  {kind:"reply",    requestId, outcome:{status:"ok",value}|{status:"failed",failure}}
  {kind:"event",    family, payload}
  ```
- **Control port commands (coordinator → main):**
  - `resolveGatewayConnection`
  - `mintLocalExecDaemonCredential` and `spawnLocalExecDaemon`
  - WebAuthn consent and PIN prompts
  - telemetry spans
  - `listRoutedMcpTools` and `executeRoutedMcpTool`
  - events up to main, such as `agents-event`, which drives OS notifications
- **Renderer port handoff.** The renderer calls `ipcRenderer.invoke("sand:coordinator-port-request")`. Main checks that the request comes from the trusted main frame, then sends the port with `webContents.postMessage(...,[port])`. Preload exposes it as `window.coordinatorPort` through a single-owner broker. **After that the renderer talks to the coordinator directly, and main is out of the hot path.** The port can be handed off only once; asking again relaunches the coordinator.

### 1.2 Coordinator ↔ host gateway

- **Connection.** `SandHostSupervisor` calls `resolveGatewayConnection`, and main calls `connector.connect()`. That calls Connect RPC `aiserver.v1.GrokBotService.EnsureSandBox` and returns `{gatewayUrl, gatewayToken, networkToken, vncUrl, forkVncBaseUrl}`. The result is cached and health-probed with `GET /health`.
- **Commands.** `POST {base}/api/<method>` with a JSON body. Replies are JSON, gzipped once they reach 1.4 KB. The table of about 129 commands is `SAND_GATEWAY_COMMANDS` in `host/gateway-protocol.ts`:
  - transcript: `sendPrompt`, `getTranscript`, `openAgentTail`, `getAgentTranscriptWindow`
  - interactive replies: `respondToWidget`, `resolveLocalToolPermission`, `resolveAutoReviewApproval`, `submitSecret`
  - agents and groups: `createAgent`, `createGroup`
  - automation CRUD and shared rooms
- **Events.** `GET /events?channels=` over SSE (`host/gateway-server.ts`), with `retry: 1000`, `:ping` every 15 s and gzip. There are 17 channels: `transcript`, `client-side-tool-v2`, `agents`, `agent-upserted`, `tray`, `workflows`, `subagents`, `async-tasks`, `automations`, `mcp-servers`, `forever-box`, `teach-recording`, `box-disk-pressure`, `computer-action`, `outline`, `sharing` and `host-settings`. The coordinator re-posts each one as a port event to the renderer.
- **Auth:**
  - `Authorization: Bearer <gatewayToken>`, compared in constant time;
  - `x-anyrun-network-token` for Cursor's pod proxy;
  - requests with an `Origin` header (browsers) are rejected;
  - bodies are capped at 256 MB.
- **Resilience:**
  - SSE has a 15 s connect deadline and a 35 s stall watchdog, and reconnects with 1–10 s backoff.
  - Transport up/down is surfaced to the renderer as `coordinator-transport-state`.

### 1.3 Host process boot (`host/main.ts`)

1. Install crash guards.
2. Run `acquireHostLock()` (`host-lock.ts`). It uses an `O_EXCL` pidfile. A stale lock (dead pid, or a foreign command line) is reclaimed. A live host is SIGTERMed and taken over.
3. Create `SandHost` (`sand-host.ts`). This boots the extension registry, the event bus, the roster and the runner composition.
4. Start the box exec daemon (port 1337), unless the VM image already provides one.
5. `host.start()` loads transcripts resiliently, retrying on `SQLITE_BUSY`.
6. Start the gateway and write `gateway.json` atomically (port, pid, token).
7. Call `reportBoxReady()`.

### 1.4 The local-exec daemon (how the VM agent runs commands on your Mac)

This is **inverted RPC**: the VM can't reach your laptop, so your laptop polls the VM.

1. The coordinator's `createLocalExecDaemonSupervisor` asks main to spawn the daemon detached, with `unref()` and a `--generation-token`. The daemon **outlives the app**. Its identity is checked by pid, start time and command line. The supervisor polls liveness every 1 s and allows at most 10 respawns.
2. Main mints a backend credential at `POST api2/sand-box/local-exec-daemon-credential`. The daemon exchanges it at `/sand-box/local-exec-connection` for `{baseUrl, token, networkToken}`, which lets it **re-find the VM on its own**.
3. The daemon opens SSE `GET /local-exec/requests` and receives `exec{requestId, serverMessage}` frames, where `serverMessage` is an `agent.v1.ExecServerMessage`. It also receives `upload`, `download` and `cancel`. Results go to `POST /local-exec/responses`. Heartbeat is 10 s, the stall timeout is 35 s and files are capped at 100 MB.
4. Execution goes through `packages/shell-exec`, with an optional macOS **seatbelt** sandbox profile.
5. On the host, `local-exec-bridge.ts` presents your Mac as just another "box" for the `External*` tools. Every action passes through **local tool permission**: always, ask or never, with an admin ceiling. Approvals are persisted in `local-tool-approvals.json`.

### 1.5 The box exec daemon

`box-exec-daemon/server.ts` is a Connect server on `127.0.0.1:1337` (token `local`):
- **`ControlService`**: `ping`, `getCapabilities`, `updateEnvironmentVariables` (box secrets) and `loadMcpServers`.
- **`ExecService.exec`**: server-streaming read, shell, shell stream, background shell spawn and write-stdin. Paths are confined to the workspace and terminals dir, and symlink reads are refused.

It is the same exec-daemon contract that Cursor's background agents use. The host's `LoopbackSandBox` pings it; readiness waits up to 90 s and a 30 s watchdog follows. `SharedDesktopSandBox` multiplexes agents onto **per-agent VNC "fork windows"** and persists the assignments in `/home/box/.sand-window-assignments.json`.

---

## 2. The box lifecycle

| Aspect | How it works |
|---|---|
| **Provisioning** | `GrokBotService.EnsureSandBox`. Errors are classified by the `x-automation-failure-hint` header: `SAND_BOX_BLOCKED` backs off for 60 s to 15 min, `SAND_CLIENT_UPDATE_REQUIRED` forces an update, and unauthenticated means access denied. |
| **Other VM RPCs** | `EnsureSandBoxWindow`, `RecreateSandBox`, `ForceRecreateSandBox`, `WatchSandBoxMigration` (a stream with resume), `PresignSandBoxStore*`, `GetSandBoxRunState`, `NotifySandAgentTurnFinished`, plus admin hibernate and snapshot. |
| **Image** | Cursor's `cursorenvironments/universal`, tagged `sand-box-latest`. |
| **Hibernation** | [inferred] VNC URLs carry `resume_lower_s=900&resume_upper_s=18000` wake hints, which suggests idle pods hibernate and resume. |
| **Update / reset** | The `forever-box` extension calls `recreateInBox({preserveData, force})`. Migration phases are `backing-up → creating → moving → cleaning-up → wiping → done`, streamed to the UI. |
| **Durability** | `box-store-sync` runs every 2 min, snapshots the Chrome session every 15 min, and captures `store.db` 5 s after a change. Files go up as content-addressed `blobs/<sha>`, small files are packed, and a `manifest.json` is written with an ETag compare-and-swap. SQLite is snapshotted with `VACUUM INTO`. A recreated VM rehydrates through `host --box-copy-in`. |
| **Host self-upgrade** | Polls an S3 `sand-host-bundle-latest.version` about every 24 h, downloads the tgz and stages it for the in-image supervisor to swap. It first quiesces automations, sharing and the transcript, and running turns return `quiescedForUpgrade`. There is **no signature check** on the tarball. |
| **Egress tunnel** | The desktop opens a WebSocket to VM port 8790 and proxies TCP from the VM out through the user's own network. |
| **VNC** | noVNC on 6080 (primary) and 6081 (fork windows). The renderer embeds it in a `<webview>` partition (`persist:sand-forever-box`) and tracks liveness telemetry. |

---

## 3. Persistence: three layers, plus the client

All per-agent data lives under `<root>/agents/<agentId>/`. The root is `~/.grokbot` on the desktop, or `/home/box/sand-data` in the VM.

### A. UI transcript in per-agent SQLite (`store.db`)
- Uses `node:sqlite` in WAL mode. Schema (`host/extensions/session/agent-db-schema.ts`):
  - `kv(key,value)` for metadata, with compare-and-set;
  - `transcript_entries(seq PK, id UNIQUE, entry JSON)`.
- Inserts are `INSERT OR IGNORE` by id, which makes them idempotent. Partial indexes support windowed paging, and threads are entries with `branched:true` plus a `replyTo` chain.
- Entry ids encode the turn: `t12u` (user message of turn 12), `t12ua0` (its attachment), `t12s3` (the 3rd SendMessage in turn 12).

### B. Model conversation state as a content-addressed blob DAG (`conversation-blobs.db`)
- `blobId = sha256(bytes)`. The root `ConversationStateStructure` (protobuf) references turns, steps, shell output, todos, summary and subagent state by blob id (`packages/agent-kv`).
- A checkpoint writes the new root, then updates `latestRootBlobId`. Production pins a fixed mutable slot, `sand-live-conversation-root-v1__`.
- Each agent has its own blob-encryption key. The format is the same one Cursor's own agents use.

### C. JSONL transcript mirror (`agent-transcripts/<id>/<id>.jsonl`)
- An append-only journal that the model can grep (`{role, message:{content:[text|tool_use|tool_result]}}`).
- Writes are crash-safe two-phase commits: a pending WAL, then write `.part`, fsync, rename and fsync the directory. Recovery replays only if the device, inode and offset still match.

### Ordering and consistency (`HostReplicaWriter`)
- Every live event carries `ordered:{replicaKey, epoch, sequence}`. The epoch is a random UUID per host process, and the sequence increases monotonically per `"roster"` or `"transcript:<agentId>"`.
- Snapshots carry their coverage range. Clients drop stale or duplicate deltas, detect host restarts (a new epoch), and stitch snapshot plus deltas.
- The host advertises the capabilities `orderedReplicasV1` and `sendAcceptanceV1`.

### The desktop never owns state
- The desktop reads transcripts through bounded windows (`openAgentTail`, `getAgentTranscriptWindow({beforeSeq, limit})`).
- Renderer-only UI state (drafts, layout) lives in `<userData>/sand-client-persistence/`, with 8 MB per value and 256 MB in total.

---

## 4. The host extension system

- **Declaration** (`internal/host-extensions.ts`): `{kind:"host-extension", id, dependencies[], start(ctx) → Api}`. `ctx` has `deps`, `host` and `onStop(teardown)`, and nothing else.
- **Boot.** A deterministic Kahn topological sort. Missing dependencies and cycles are rejected. A failed start rolls back the teardowns registered so far, and `stop()` runs teardowns in LIFO order.
- **No self-registered RPC.** All gateway methods live in one table in `host/host-gateway-api.ts`, which calls `extensions.api("<id>")`.
- **The 35 extensions, by domain:**
  - **core:** auth, settings, experiments, telemetry, trays, source-map, turn-execution
  - **conversation:** session, transcript, inference, memory, attachments, content-search
  - **box:** box-lifecycle, forever-box, box-store-sync, state-backstop, host-upgrade, wallpaper, browser-ua, webauthn-proxy
  - **tools:** mcp, managed-setup, local-exec, local-tool-permission, secrets, cloud-agents, codebase-telemetry, action-audit, auto-review, teach-recording
  - **background:** automations, notify-bus, notifications (mobile push), cross-user-sharing
- **`turn-execution`** is a late-bound port (`bindExecutor`). It breaks the dependency cycle between the transcript and the runner.

### Event buses
- **`SandHostEventBus`**: a typed broadcast that becomes the SSE feed, plus topic events such as `transcript.run-started`.
- **notify-bus**: a backend server-stream with the topics `automation-fires`, `listener-events` and `xuser-events`. It reconnects with backoff from 1 to 60 s. A drain gate turns pushes into "poll now" decisions, with a 4 s floor and a safety poll every 120 s.

### Scheduling primitives (`internal/scheduling.ts`)
Every background loop in every process is built from named policies: Debounce, Retry (exponential, abortable), IdleWatchdog, Polling (no overlap), Expiry (per-key TTL) and Deadline. All of them use unref'd timers.

### Routines are fired by the backend
- `shared/automation-schedule.ts` parses cron, but **locally only to show "next run"**.
- `SandAutomationCloudSync` mirrors every routine as a "shadow" `AutomationsService` automation, with the prefix `sand-shadow:`.
- The backend fires it, and notify-bus pushes `automation-fires`. `SandAutomationFireConsumer` polls `/sand/automation-events/poll`. The fire is deduped, passed through the spend guard and enqueued, then the runner calls `runner.run(wakePrompt, {hidden:true, isSilenceAllowed:true, requestSource:"automation"})`.
- Event triggers (GitHub, Slack and others) arrive the same way through `listener-events`, via `SandTriggerHub`.

### Run queue
- `SandRunScheduler` (`host/extensions/transcript/run-scheduler.ts`) allows **exactly one active run per agent**, with three lanes in priority order: **user > agent > background**.
- A watchdog interrupts a run that has blocked a waiting user message for 120 s, and detaches it after a further 30 s.
- Background shells and subagents register in `RevivingBackgroundWorkRegistry`. Their completion triggers a **revival turn**.

---

## 5. Auth, secrets, updates, telemetry, flags

| Area | Mechanism |
|---|---|
| **Login** | Cursor "deep control" PKCE. Open `cursor.com/loginDeepControl?challenge&uuid&redirectTarget=sand`, then poll `api2/auth/poll` up to 150 times with backoff. Tokens are refreshed at `/oauth/token` when fewer than 5 minutes remain. |
| **Tokens in the VM** | The VM never gets your access token. It gets a *renewal credential* and exchanges it at `api2/sand-box/inference-credential` for short-lived tokens, renewed 2 minutes before expiry. |
| **Backend headers** | `authorization`, `x-cursor-checksum` (time plus machine id), `x-cursor-client-type: sand`, `x-sand-box-namespace`, `x-ghost-mode` (privacy mode), and `x-request-id` plus trace headers. |
| **Desktop secrets** | Electron `safeStorage` (Keychain or DPAPI) in `sand-secrets.json`, scoped per account by the hash of the account `sub`. |
| **VM secrets** | Plaintext `box-secrets.json` (mode 0600) in the VM, applied as exec-daemon environment variables. Names starting `SAND_`, `LD_` or `__CURSOR` are reserved. |
| **Updates** | Squirrel feed at `api2.cursor.sh/updates/...`, checked 30 s after start and then hourly. Tracks are stable, nightly and dogfood. The minimum version comes from the Statsig config `sand_min_client_version`. |
| **Telemetry** | Sentry through `metrics.cursor.sh`, `AnalyticsService.TrackEvents` (buffer of 200, flushed every 3 s), OTLP traces, and a send-to-echo latency recorder. |
| **Feature flags** | Statsig, bootstrapped by the server through `AnalyticsService/BootstrapStatsig` and re-polled every 5 minutes. The registry has about 845 gates. Sand-specific ones include `sand_multitask`, `sand_memory_dreaming`, `sand_notify_bus`, `sand_auto_review`, `sand_agent_network`, `sand_browser_use_subagent`, `sand_spotlight` and `grok_bot_dynamic_tools`. Dynamic configs include `sand_default_model`, `sand_automations_model` and `grok_bot_conversation_size_limits`. |

---

## 6. Inference backends

### Native (the shipped app)
- The turn runs **in the VM host**. `host/extensions/inference/cursor-session.ts` builds a Connect client for **`aiserver.v1.InferenceService.Stream`** on api2.
- Default `SAND_DEFAULT_MODEL_ID = "grok-4.5"`, with maxMode, `effort:high` and `fast:true`. It can be overridden by Statsig or by `SAND_AGENT_MODEL`.
- The Cursor backend also provides `AiService.runWebSearch/runWebFetch/runGenerateImage`, MCP OAuth validation, `BackgroundComposerService` (cloud agents), `DashboardService` (profile, teams, usage, plugin marketplace) and labeling RPCs.

### Reconstruction-only: the Inference Router
- **Coordinator path.** If the setting is not `cursor`, the coordinator **intercepts `sendPrompt` on the desktop**. It runs Claude Code (`@anthropic-ai/claude-agent-sdk`), Codex (`chatgpt.com/backend-api/codex/responses` using `~/.codex` auth) or OpenRouter (AI SDK). It fakes transcript and roster events for the UI and stores the history in `inference-router-transcript.json`.
- **Tool limits.** Routed providers only get the desktop's plugin and MCP tools, through an ephemeral loopback MCP bridge. They don't get the VM's shell, browser or computer tools.
- **In-box path.** There is also an in-box path (`turn-run-shell.ts:185`) that swaps only the model and keeps the native runner and tools. The coordinator intercept wins when both are configured.

---

## 7. Lessons for openbot's architecture

1. **Put the agent where the computer is.** A long-lived host inside the sandbox, exposing an HTTP command API plus an SSE event stream, makes "keeps working when you close the laptop" free.
2. **The desktop is stateless.** It reads windows of data and reconciles with `{epoch, sequence}` stamps. Restarts and reconnects become trivial.
3. **Use inverted RPC for "run on my machine".** The local daemon long-polls the server, so there is no inbound port on the user's machine. Gate every action with a persisted permission.
4. **Layer durability.** Use SQLite for UI rows, a content-addressed blob DAG for model state, a JSONL journal for greppable history, and object-store sync for the whole VM home.
5. **Keep extension DI tiny.** An extension is `{id, deps, start, onStop}` plus a topological sort, with one central RPC table.
6. **Keep scheduling server-side.** Cron fires come from the backend through a push stream, so local timers are not trusted for correctness.
