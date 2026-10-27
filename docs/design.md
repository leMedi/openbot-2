# OpenBot: design

OpenBot is an open-source alternative to Grok Bot. You run it on your own machine as one Docker container. It gives you a team of always-on bots. Each bot has its own instructions, memory and routines, and its own screen on the container's desktop, which you can watch and take over from the web.

This document records the decisions agreed on 2026-10-25 and 2026-10-26. The research behind them is in [`grok-bot/`](grok-bot/README.md) (with the UI spec in [`grok-bot/05-ui.md`](grok-bot/05-ui.md)) and in [`research/cua-overview.md`](research/cua-overview.md).

---

## 1. Product scope

| Area | P0 (first usable install) | P1 | P2 |
|---|---|---|---|
| Deploy | Runtime image, compose sample, `install.sh`, env-configured paths | In-app updater with GitHub Releases, auto-update when idle | |
| Onboarding | Connect provider → default model → first bot | | |
| Bots | Create (popup), edit, hard delete, per-bot model override | | Animated avatars |
| Chat | Multi-bubble SendMessage chat, markdown, reply guarantee, question / take-over cards, attachments | Reactions, threads, ⌘K palette, global search, browser notifications | KaTeX, Mermaid, link previews, file viewers, find-in-chat |
| Sidebar | Status dots, unread, Draft / Waiting lines, pin, rename, delete | Named sections, multi-select, hidden bots, ⌘B rail | |
| Computer | Per-bot display (always on), noVNC preview + take control, computerUse subagent | | |
| Bot ↔ bot | `message_bot` (Grok semantics) | | |
| Groups | Slack-style new group, Grok round rules | | |
| Memory | | Bot + shared memory, tiers, extraction, episodes, consolidation | Bots edit their own profile (#51) |
| Routines | | Cron, aliases, `@every`, one-off `at` | Webhook triggers |
| Plugins | | Bundled catalog, accounts, per-bot grants, MCP via pi-mcp | |
| Vault | | Items, grants, fill-login, secret request, TOTP | |
| Orchestrator | Port + `AllowAllOrchestrator` + audit log | `LlmOrchestrator` (shadow by default), rules UI | |
| Security | | **Protect secrets from bots with root** (secrets broker) | Optional auth |
| Evals | Fake world + first suites | More suites, CI pass rates | |
| Mobile | | | Expo app, on-device Whisper STT, Expo Push |
| Marketing site | | Astro site at `OPENBOT_SITE_URL` | |

Not planned: bots creating bots, bot-written or user-written skills (all skills come from plugins), cross-user shared rooms, Slack/Discord channels, running commands on the user's own machine, an egress tunnel, teach-by-demonstration, projects, image generation, in-app evals, the org chart.

---

## 2. Deployment

### 2.1 Single owner, single container

- One instance belongs to one person. There are no user rows; the server has a `getOwner(request)` seam so auth can be added later in one place.
- **No auth for now** (ADR 0003). OpenBot runs on private networks only and knows nothing about how they're kept private; protecting ports is not a priority. Over plain HTTP (not `localhost`) the browser blocks clipboard and microphone; HTTPS, if wanted, comes from whatever the owner puts in front.
- One container runs everything under supervisord:
  - `openbot` server (TanStack Start): UI, `/api/*`, SSE, the screen-stream proxy (`/api/screens/:botId/stream`), agent runtime, scheduler, MCP manager. Runs as user `openbot-server`.
  - `openbot-desktopd`: owns every bot's Xvfb, Openbox, Google Chrome, x11vnc and cua-driver. Runs as user `openbot`. Talks to the server over a Unix socket. Displays survive server restarts.
  - pi-env daemons, spawned by the server as user `openbot`, run bots' shell and file tools.
- Bots have **full passwordless sudo**: it is their computer.
- **Container only.** Bots run only in the runtime image; other platforms aren't planned. A server started outside it (no `openbot` user, or no pi-env daemon for the machine) still serves the UI but refuses to run bots, with an error saying so, rather than running their commands as its own user (#47). Develop with `pnpm dev:up`.

### 2.2 Known risks (accepted for now)

1. **Bots can call the API.** With no auth, anything that reaches the port is the owner, including a bot's shell. Fix later: `iptables -m owner --uid-owner openbot` reject on the server port.
2. **Bots with root can read secrets.** The vault, provider tokens and MCP credentials are encrypted, but the key is on the same machine. **P1:** move secrets and the key into a small secrets-broker container that only the server can call.

### 2.3 Paths and environment

Only values needed before the database opens are env vars. Everything else lives in the `settings` table.

| Env var | Default | Holds |
|---|---|---|
| `OPENBOT_DATA_DIR` | `/var/lib/openbot` | libSQL db, pi-durable storage, copies of messages' attachments, plugin installs, audit log. Mode 0700, server user only. |
| `OPENBOT_HOME` | `/home/openbot` | Bots' world: `shared/`, `bots/<id>/` (workspace, uploads, browser profile), installed tools |
| `OPENBOT_APP_DIR` | `/opt/openbot` | `releases/<version>/`, `current` symlink |
| `OPENBOT_SECRET_KEY` | generated on first boot | Encryption of vault and system credentials |
| `OPENBOT_PUBLIC_URL`, `OPENBOT_PORT` | `3000` | Links and OAuth redirects; the public URL's host is also allowed by the dev server |
| `OPENBOT_HOST` | `0.0.0.0` in the image, localhost on the host | Listen address of the one port |
| `OPENBOT_DEV` | unset | Dev mode: disables the updater |

The compose sample mounts three named volumes: `openbot-data`, `openbot-home`, `openbot-app`. Only one port is exposed; noVNC goes through the server.

### 2.4 Updates and versioning

- **Runtime image** (`ghcr.io/<owner>/openbot-runtime:r<N>`): Debian trixie, Node, Google Chrome, Xvfb, Openbox, noVNC, supervisord, cua-driver (pinned, sigstore-verified). Rebuilt only when `docker/**` changes. Updated with `docker compose pull && up -d`.
- **App releases**: every push to `main` builds `0.<minor>.<run>` (minor from the `VERSION` file). The GitHub Release carries the app tarball, `SHA256SUMS`, `release.json` (version, `minRuntime`, migrations, changelog) and `install.sh`. The image also embeds the release it was built with.
- **Updater** (Settings → Updates; manual, notify or auto-when-idle): download, verify sha256, run migrations, quiesce (stop new runs; pi-durable resumes in-flight ones), swap the `current` symlink, restart only the server, health-check, roll back on failure. Refuses releases whose `minRuntime` is newer than the running image.

As built (#19):

- **Workflow** `.github/workflows/release.yml`, on every push to `main`: typecheck and tests, the computer's contract suite in the runtime image (dev target), then `node scripts/src/cli.ts package` builds the release and `scripts/smoke-release.sh` starts it. Any failure blocks the release. Pull requests run the same checks and publish nothing. The GitHub Release `v<version>` carries `openbot-<version>.tar.gz`, `release.json`, `compose.yml` (the compose sample), `install.sh` and `SHA256SUMS`, with the changelog as notes; a rerun of the same run uploads them again. Before publishing, the `install` job builds the runtime image (amd64) from the release and runs `scripts/smoke-install.sh` against the release's files.
- **Version** `0.<minor>.<run>`: `VERSION` holds `0.<minor>`, `<run>` is the workflow's run number, so versions grow with every push and bumping `VERSION` moves the minor.
- **Runtime revision** `r<N>`: the number of commits on main's first-parent history that changed the image's definition (`docker/`, except `docker/dev/` and compose files), so it only moves when the image does. When the registry says `r<N>` isn't there (any other registry error fails the run), CI builds the `runtime` target natively for amd64 and arm64 (`ARM64_RUNNER` variable picks the arm64 runner), smoke-tests each (`scripts/smoke-image.sh`), and tags both as `r<N>` and `latest`. The release waits for it.
- **Manifest** `release.json`: `version`, `commit`, `createdAt`, `archive`, `minRuntime` (`r<N>` of the release's own commit) and `runtimeImage`, `migrations` (whether `packages/db/drizzle` changed since the previous release, the latest `v*` tag on the commit's history; true for the first), `previous`, `siteUrl`, and `changelog` (main's first-parent subjects since then, merges by their summary).
- **Shared config** `release.env`: `OPENBOT_SITE_URL` (for now `https://github.com/leMedi/openbot-2/releases/latest/download`, the latest release's `install.sh` asset; later `https://openbot.lemedi.dev`), `OPENBOT_RUNTIME_IMAGE` (`ghcr.io/lemedi/openbot-runtime`) and `OPENBOT_RELEASES_URL` (`https://github.com/leMedi/openbot-2/releases`, where the installer downloads releases). Repository variables of the same names override them in CI.
- **Archive**: unpacks into `releases/<version>/` with `bin/start`, `release.json`, the workspace's sources without tests, the built web app (`apps/webapp/dist`) and production dependencies for linux x64 and arm64, installed flat (pnpm `node-linker=hoisted`). The server build bundles the web app and the workspace packages but no dependency, so pi-env keeps its daemon binaries (`bin/`), libSQL its native module, and `@openbot/db` finds its migrations through its own package. The build itself runs on a hoisted install, which is what makes Vite leave dependencies out.
- **`bin/start`** runs `apps/webapp/src/server/start.ts` with plain Node: static files from `dist/client`, everything else through TanStack Start's server build (via srvx), and screen streams on the same server's `upgrade` event, in the API's process. It sets `NODE_ENV=production` and `OPENBOT_VERSION`, which `/api/health` reports (`dev` from the repo).
- **Embedded release**: the `runtime` target requires the release folder as the `release` build context (`docker build docker --target runtime --build-context release=<dir>`) and copies it into `/usr/local/share/openbot/release`; `dev` has none. On every start the entrypoint runs `openbot-install-release`: it checks `SHA256SUMS`, unpacks the archive into `$OPENBOT_APP_DIR/releases/<version>` and points `current` at it when nothing is installed or the installed release is older; a newer one stays. So until the updater exists, pulling a newer image also moves the app to at least its embedded release.
- **Compose sample** `docker/compose.yml`: the image (`OPENBOT_IMAGE`), the port, and the `openbot-data`, `openbot-home` and `openbot-app` volumes. The installer (#20) writes it.

### 2.5 Installer

`curl -fsSL https://github.com/leMedi/openbot-2/releases/latest/download/install.sh | bash` for now (later `https://openbot.lemedi.dev/install.sh`). The URL comes from `OPENBOT_SITE_URL` in shared repo config and a GitHub Actions variable.

1. Check Linux x86_64/arm64, Docker and Compose v2. Offer `get.docker.com` if Docker is missing.
2. Ask (or take flags): install dir (`~/openbot`) and port.
3. Write `docker-compose.yml` and `.env` (generated secret, pinned runtime tag).
4. `docker compose pull && up -d`, wait for `/api/health`, print the URL.

Re-running never overwrites `.env`; it offers a runtime update. Flags: `--yes --dir --port`.

As built (#20):

- **`scripts/install.sh`**, published by packaging as the release's `install.sh` with `default_site_url` and `default_releases_url` set from the release config (`scripts/src/install-script.ts`). The site is meant to serve it at `<site URL>/install.sh`, e.g. by redirecting to `<releases URL>/latest/download/install.sh`. `OPENBOT_SITE_URL` and `OPENBOT_RELEASES_URL` in the environment override the defaults.
- **Release files**: `release.json` and `compose.yml` from `<releases URL>/latest/download/` (or `download/v<version>/` with `--version`), checked against the release's `SHA256SUMS`. The image pinned in `.env` is `release.json`'s `runtimeImage`.
- **Prompts** read `/dev/tty`, so they work under `curl … | bash`: install dir and port. With `--yes`, or without a terminal, the defaults and flags are taken; but Docker is only installed, and the image only changed, with `--yes` or a yes on the terminal. Flags: `--yes --dir --port --public-url --version --image`.
- **Docker**: missing → `get.docker.com` (`OPENBOT_GET_DOCKER_URL`) as root or with sudo; a user outside the docker group gets `sudo docker`; Compose v2 is required.
- **`.env`** (mode 0600): `OPENBOT_IMAGE`, `OPENBOT_PORT`, `OPENBOT_PUBLIC_URL` (`http://<host's first address>:<port>`, or `--public-url`), and `OPENBOT_SECRET_KEY` (32 random bytes, base64url, like the server's own). If the `openbot_openbot-data` volume already exists, the key is left empty with a warning, so the server keeps the key it generated there rather than a new one that can't read the stored credentials.
- **Re-run** (an `.env` in the dir): the `.env` is kept and flags that would change it are ignored with a warning. `compose.yml` is refreshed from the release (the old one kept as `.bak` if it differed). When the release pins a newer `r<N>` of the same image, it offers to update and changes only the `OPENBOT_IMAGE` line.
- **No network setup** (#50, ADR 0003): OpenBot serves plain HTTP on the port. Keeping that port on a private network is the owner's business.
- **Start**: `docker compose up --detach` (pulls the image if it isn't there yet), then polls `http://127.0.0.1:<port>/api/health` until it reports `"status":"ok"` (`OPENBOT_HEALTH_TIMEOUT`, 600 s), and prints the version and URL. On timeout or if the container exits, it prints the logs and fails.
- **Tests**: `scripts/smoke-install.sh <release dir>` serves the release from a `file://` URL laid out like GitHub's, then does an unattended install, a re-run (checking the `.env` didn't change), and an interactive install through `script`. CI's `install` job runs it.

### 2.6 Dev setup

`docker/compose.dev.yml` uses the same runtime image with a `dev` target (pnpm, build tools). The repo is bind-mounted at `/opt/openbot/current`, `node_modules` lives in a named volume, and supervisord runs `pnpm dev` (Vite HMR, `tsx watch` for desktopd). Separate dev volumes. Commands: `pnpm dev:up`, `dev:sh`, `dev:reset`, `dev:seed`. An optional `.devcontainer/` points at the same compose file. Evals run on the host.

As built (#10):

- `docker/Dockerfile` has two targets: `runtime` (Debian trixie pinned by digest, Node from nodejs.org checked by SHA-256, Google Chrome stable from Google's apt repository (signed; the key checked by fingerprint, amd64 and arm64), Xvfb, Openbox, x11vnc + websockify, supervisord) and `dev` (adds pnpm and build tools). The noVNC web client will be served by the web app.
- Users: `openbot` (uid 2000, passwordless sudo) and `openbot-server` (uid 2001, may run commands as `openbot` only). The entrypoint sets the data dir to 0700 for the server, makes `$OPENBOT_HOME/{shared,bots}` for `openbot`, and the server generates `secret.key` there on its first start when `OPENBOT_SECRET_KEY` is empty.
- The `runtime` target starts `$OPENBOT_APP_DIR/current/bin/start` as `openbot-server`; the release pipeline provides it. Without one the server waits.
- In dev, every workspace package's `node_modules` is its own volume (the entrypoint refuses to start if one is missing, so Linux binaries never land in the host's checkout), the server runs `pnpm install` then `pnpm dev`, and on a Linux host `openbot-server` takes the repo owner's uid. Turbo passes `OPENBOT_*` through to tasks.
- Commands: `pnpm dev:up` (build, start, wait until healthy), `dev:sh`, `dev:seed` (sample bots Ada, Linus and Grace, and a "Launch team" group), `dev:logs`, `dev:down`, `dev:reset` (deletes the `openbot-dev_*` volumes). `OPENBOT_DEV_PORT` picks the host port.

---

## 3. Bots, conversations and groups

### 3.1 Bots

- Fields: name (unique ignoring case; bots are mentioned by name), title, instructions, avatar shape and color, `model` (null follows `settings.defaultModel`), display number, `pi_conversation_id`, sidebar `section_id` and `pinned_position` (P1).
- **New bot** opens a popup with those fields. **New group chat** opens an empty conversation with a Slack-style "To:" chip field; the first message creates the group.
- **Delete is permanent.** It removes the bot row, its pi conversation, 1:1 messages, routines, memory, grants, rules, audit entries, display and `$OPENBOT_HOME/bots/<id>/`, and removes it from groups. Messages it left elsewhere keep an `author_name` snapshot and show as "Name (deleted)". Shared memory facts it wrote stay, shown as "via Name (deleted)".

### 3.2 One conversation per bot (Grok's model)

Each bot has **one unified pi-durable conversation** (this supersedes the earlier one-conversation-per-group decision). Every input reaches it with a tag:

| Input | Lane | Shape |
|---|---|---|
| Your message in the 1:1 | user | plain user message |
| Group turn | user | `[Group chat: "Launch" - with Ana, Rex]` + messages since it last spoke (≤ 24) |
| Another bot's message | agent | hidden `[agent]` cue, silence allowed |
| Routine fire | background | hidden `[routine: name]` cue, silence allowed |
| Subagent / background completion | background | revival turn |

One active run per bot, lanes ordered owner > bot > background. As in Grok, there is no Stop: the owner's new message **supersedes** the run in progress (it is aborted, its running tool included, and the owner's unanswered messages carry into the next run, with a `sendMessage` guard so no stale answer is posted). A priority bot message also interrupts a run, but never one for the owner (§3.5). Queued work is never dropped. A watchdog interrupts a run the owner's message has waited 120 s behind, and detaches it 30 s later.

As built (#39), in `RunScheduler` (`@openbot/agent`, `run-scheduler.ts`), which `BotRuntime` drives each bot's pi-durable history with:

- **Queue:** one per bot, run by one driver, one run at a time: the next run is submitted once the history is idle. Order: the owner's DM messages, group turns, priority bot messages, interrupted work, the bot lane, the background lane, oldest first within each. The owner's DM messages waiting (and answers to cards, and hand-backs) run together, as one input. Submissions and aborts of a bot go through one chain, in order, and an interrupt is decided after the run's submission: one that already ended has nothing to interrupt.
- **Supersede:** the owner's DM message interrupts any run: an owner run, a group turn, bot or background work. From then on the old run's `sendMessage` and `askQuestion` calls are blocked (`outdatedAnswer`), and its history is aborted, which cancels its running tool (a computer-use session included). The owner's earlier messages are in the history already; the new input starts with `supersededNote` when it superseded a run answering them. Interrupted bot and background work runs again after it, with `interruptedNote`, however often it is interrupted, unless it answered before the abort reached it; a group turn is retried the same way, up to 3 runs (a turn interrupted on its third ends there, and its rounds go on), and its rounds wait for it (`takeTurn` resolves once its last run ends).
- **Watchdog** (`Watchdog`, 120 s + 30 s; tests pass shorter ones): when the owner's message has waited 120 s behind a run, the run is aborted again; 30 s later it is detached: every call of a bot's tool still running in it gives up (each tool is wrapped to; the work it started, e.g. a shell command, is abandoned, not killed), so pi-durable's abort, which waits for the run's calls, can end, and the queue moves on. Until the detached run has ended, its `sendMessage` calls are blocked too. **Limit:** a run wedged outside a tool call (a model stream or a hook that never returns) keeps the history busy; pi-durable can't end it, and the owner's message waits for it.
- **Seam 1:** `chat.test.ts` (supersede, a long tool interrupted, the watchdog), `bot-messages.test.ts` (lanes), `groups.test.ts` (a group turn interrupted and retried); `run-scheduler.test.ts` covers the scheduler's races against a fake history.

### 3.3 The bot's voice

The model's plain text is private. The only way to reach you is `sendMessage` (several short bubbles, attachments, question widgets, cards). If a run that answers your message ends without a `sendMessage`, a reminder forces a reply (Grok's reply guarantee). It holds across restarts as Grok's ack obligations do: your DM message, answer or hand-back marks the bot as owing you a reply (`bots.reply_owed_at`, in the same transaction), and its next message or card in the DM clears it. A bot still owing one when the server starts is woken, once any resumed run has ended, with a recovery note and your messages since its last reply; it gives up after 3 starts.

As built (#40), question cards dismiss as Grok's do:

- The owner can dismiss an open card with its ×: it shows "Dismissed", can't be answered any more, and doesn't wake the bot (`chats.dismiss`). Letter keys skip dismissed cards.
- `askQuestion({ dismissOnMoveOn: true })`, for low-stakes questions only: the owner's next message in the DM dismisses the card if they left it unanswered. Without it a card stays answerable indefinitely.
- Each run the scheduler starts in the bot's DM (not a group turn) begins with `Unanswered questions:\n- <prompt>` for every question still unanswered, open or dismissed; `messages.card_state.reminded` then keeps it from being listed again. Open cards stay answerable.
- **Seam 1:** `questions.test.ts`.

As built (#12), attachments:

- The owner drops, drags, pastes or picks up to 6 files (50 MB each) in the composer; `chats.send` takes them as a multipart form. Each is saved as `openbot` to the bot's `uploads/` folder (`notes-2.txt` when the name is taken, never outside it). The bot's input lists their paths, and images go to the model as image input, shrunk by pi-durable's Photon image processor to fit (the same processor lets `read` show any image).
- `sendMessage` takes `attachments`: paths on the computer, absolute or relative to the bot's folder. A file that isn't there fails the call and posts nothing.
- The server keeps a copy of every message's files in `$OPENBOT_DATA_DIR/attachments/<chatId>/<id>`, so a download is the file as it was when posted. `GET /api/messages/{messageId}/attachments/{attachmentId}` always serves it as a download (`attachment`, `sandbox` CSP, `nosniff`). Deleting a bot deletes its DM's copies; deleting a group chat, the group's (§3.4).
- Transcript: images and videos in a gallery (320px high, 10px corners) that opens a full-screen viewer, other files as download chips; a message of files only isn't bubbled. The sidebar summarises it as "Sent 2 images" / "Sent a file".

### 3.4 Groups

Grok's rules: at most 3 rounds and 10 member turns per human message, speaker order rotates each round, `@name` / `@everyone` picks responders, `(pass)` means silent, at most 2 messages per member turn, and members never reveal private 1:1 context. The older `maxRunsPerBot` / `maxTurnsPerMessage` columns are replaced by these.

As built (#18):

- **Creating:** "+ New → New group chat" opens `/groups/new`, an empty chat with a "To:" field where bot names become chips; the first message calls `POST /groups` (`memberIds`, `text`), which creates the group and posts the message. A group has 2–6 bots (Grok's cap). Its name is its `title`, or its members' names joined with ", " until the owner renames it (sidebar Rename, or the Members pane; blank names it after its members again). `ChatInfo` carries `name`, `title`, `members` and `speaking` (the member taking its turn); renaming a member, deleting one, renaming or changing the group all publish `chat.updated`.
- **Members pane:** the name, each member (linking to its DM) with Remove (confirming "Remove X from this conversation?"), and Add member. `PATCH /groups/{chatId}` takes `title` and/or `memberIds` (turn order).
- **Rounds** (`GroupRounds` in core): a message in the group (the owner's, or a member's post) starts rounds. Each round, members answer one at a time in member order rotated by the round number (round 2 starts with round 1's second speaker). A member gets a turn only if someone else posted since its last turn. A round in which nobody posts ends them; so do 3 rounds or 10 member turns. Mentions: `@everyone`, or no mention, lets every member answer (the poster sits out round 1); `@Name` restricts the rounds to the members named, plus those they mention in their answers (a handoff). A newer owner message ends the rounds going on after the turn in progress and starts its own; a member's post while rounds go on doesn't, and members read it on their next turn.
- **A turn** is an owner-lane input with `groupChatId`, awaited with the new `AgentRuntime.takeTurn` (resolves when the run ends or is dropped). It shows `[Group chat: "Launch" - with Ana, Rex]`, the rules of a turn, then the messages others posted since the member's last turn (`chats.turn_cursors` keeps, per member, the newest message its last turn showed): the newest 24, with "(N earlier messages not shown)". **Lanes:** a group turn waits for the bot's current run; the owner's DM message interrupts it, and the turn is retried after the DM, up to 3 runs (§3.2). In a turn, `sendMessage` posts to the group (the chat is read back from the history's newest input, so a resumed run posts there too), at most 2 messages (a third call fails, posting nothing), and only while the bot is still a member; "(pass)" or sending nothing passes and posts nothing; there is no reply reminder. `askQuestion` is refused in a turn (cards stay in DMs); a take-over card still goes to the DM.
- **One history:** turns go into the member's single history (ADR 0001), so in its DM it can answer about the group. The prompt lists the bot's group chats and says never to reveal its DM with the owner there.
- **Bots posting:** `message_bot({ to })` also takes a group chat's name (ignoring case and a leading `@` or `#`). Only members can post; the post is the sender's message in the group (no DM entries) and starts rounds like the owner's, unless rounds are going on. A member can't post to the group whose turn it is taking (it uses `sendMessage`).
- **Owner files** (#43): the owner's files in a group chat are saved as `openbot` to `$OPENBOT_HOME/shared/groups/<chatId>/` (outside any bot's folder, readable by every member; `notes-2.txt` when the name is taken), and every member's turn lists their paths under the owner's message. The server keeps copies as for DMs.
- **Deleting** (#43): the sidebar menu and the Members pane delete a group chat after a confirmation. `DELETE /groups/{chatId}` deletes the chat row first (its messages and turn cursors go with it), ends its rounds, drops members' turns queued in it and aborts the one running (`AgentRuntime.endGroupTurns`; a turn whose group is gone never starts), then deletes its attachment copies and its shared folder, and publishes `chat.deleted`. Members stay, and what they said stays in their histories (ADR 0001).
- **Not yet:** rounds, like the bots' queues, live in memory and stop at a restart (#33). A member busy in its DM holds up the group's rounds until that run ends. The Seam 1 suite is `groups.test.ts`.

### 3.5 Bot ↔ bot (Grok's `SendToAgent`)

`message_bot({ to, text, images?, priority? })` is asynchronous and returns immediately. `to` is a bot or a group the sender belongs to. The sender's chat gets an outgoing entry and the recipient's chat an incoming entry; there are no separate bot-to-bot conversations. The recipient wakes in the agent lane; `priority` interrupts its current non-user run. Prompt rules are copied from Grok: use sparingly, fan out only on request, never relay your venting verbatim, no acknowledgement ping-pong.

As built (#17):

- `message_bot({ to, text, images?, priority? })`: `to` is a bot's name (ignoring case and a leading `@`), or a group chat's (§3.4). It refuses, posting nothing, a message to the bot itself, to a name no bot has (listing the teammates), with no text and no images, or over 8,000 characters. It is never reviewed (no surface).
- **Images only (#49)**, as Grok's `SendToAgent`: up to 6 image files on the sender's computer (a path, or `file://`) or `https://` URLs. Anything else, a non-image file, another scheme, a failed or non-image download, refuses the call with nothing posted; other files go through the shared folder. An `https://` image is downloaded (30 s, 20 MB) into the recipient's uploads folder, so the recipient always sees it as image input. Grok accepts `https://` too but never resolves it (`resolveImageSource` is unwired), so its recipient never sees one; we keep its promise instead. A group post is text only: the images are dropped and the tool result says so.
- It posts one entry in each DM (`messages.direction` `to`/`from`, `peer_bot_id`, `peer_name`; the author is always the sender), each with its own copies of the images, and wakes the recipient in the bot lane with the text behind a hidden cue (`[Message from Rex, your teammate…]`). It returns "Sent to Ana. Don't wait for an answer" at once; a reply is just another `message_bot`, which wakes the sender. Silence is allowed: the reply guarantee covers the owner lane only. A replayed call posts once (idempotency keys) and wakes once (the recipient's message id is the input's request id).
- **Lanes** (`RunScheduler`, §3.2): a priority input goes ahead of the bot's other bot- and background-lane work and interrupts a bot- or background-lane run, unless it has already ended; the run's input runs again after the priority one with a note (`interruptedNote`), however often it is interrupted. Runs for the owner are never interrupted by it. The queue is in memory: work queued at a restart is lost (#22 follow-up).
- The prompt lists the teammates (name, title) and Grok's rules: message sparingly, fan out only when the owner asks, never relay the owner's venting verbatim, never wait for an answer, no acknowledgement ping-pong, priority only when it can't wait, only `sendMessage` reaches the owner.
- The transcript shows "→ to Ana" / "← from Rex" above the message, and the sidebar's preview "→ Ana: …" / "← Rex: …". Neither entry makes its DM unread (#49): as in Grok, where peer messages raise no activity, only what is for the owner does. Either DM's message keeps the other bot's name, as "Name (deleted)" once it is gone.
- **Seam 1:** `bot-messages.test.ts`, with `providers.scriptFor(name, …)` scripting each bot's model on its own, since bots now work at the same time.

---

## 4. The bot's computer

- **One X display per bot, always on.** Xvfb at 1280×800 + Openbox + its own Chrome profile at `$OPENBOT_HOME/bots/<id>/chromium` (logins are not shared between bots). Display numbers are stable per bot.
- **noVNC** per display, proxied at `/api/screens/:botId/stream`. The Screen pane shows a view-only preview; ✋ switches to interactive with "Hand back"; ⤢ opens fullscreen.
- **Tool priority**, stated in the prompt: plugin/MCP → shell and web fetch → browser → desktop.
- Browser and desktop tools live only in a **computerUse subagent** (a pi-durable task-owned conversation running `computerUseModel`, else the bot's own model). The main bot calls `use_computer({ goal, reason, startUrl? })`; the reason is logged and scored by evals. Its activity is hidden in the chat, like Grok's.
  - **Browser:** our own CDP tools (`browser_snapshot` with `[ref=eN]`, click, type, navigate, tabs, screenshot).
  - **Desktop:** cua-driver (MIT), one per display, over MCP: accessibility tree with element tokens, then act, then verify the effect.
- When stuck (login, captcha, 2FA) the subagent returns `needs_help` and the bot posts a **Take over** card that opens noVNC; the bot waits for "Done".

As built (#11), shell and files:

- Every bot has pi-durable's `bash`, `read`, `write` and `edit` tools. They run in a `RemoteExecutionEnv` on one pi-env daemon (`localDaemon()`), which the server starts as `openbot` with `sudo --non-interactive --set-home --user=openbot`, started on the first tool call and stopped with the runtime. A bot's environment starts in `$OPENBOT_HOME/bots/<id>/`, made on first use; it reaches the whole computer. This is the bots' one shell: core's `Computer` port has none (#47). Outside the runtime image `openBotComputer` refuses: sending a bot a message fails with `PRECONDITION_FAILED`, other runs fail before starting, and every environment throws `ComputerUnavailableError`.
- The prompt tells each bot it works as `openbot` with sudo, and where its folder, `shared/` and every other bot's folder are.
- `bash`, `write` and `edit` are reviewed under the `shell` surface and written to the audit log; `read` declares none. Deleting a bot deletes its folder.
- `BotComputer` (`@openbot/agent`) is the seam: Seam 1 uses `fakeBotComputer`, with files in a temporary home and commands answered from a script and recorded instead of run (`server.commands`), so tests script and see them. `computer.image.test.ts` runs the same scenarios on the real computer inside the runtime image (skipped elsewhere).

As built (#13), screens:

- **Screen daemon** (`apps/desktopd`, run by supervisord as `openbot`, `docker/desktopd.conf`): one screen per bot, each Xvfb `:N` at 1280×800, Openbox, Google Chrome (`google-chrome`) with `--user-data-dir=$OPENBOT_HOME/bots/<id>/chromium` and DevTools on `127.0.0.1:9222+N`, and x11vnc on `127.0.0.1:5900+N`. Chrome runs in its own sandbox, which in a container needs user namespaces (its setuid helper needs privileges Docker drops); on a host whose Docker keeps them from containers (GitHub's Ubuntu 24.04 runners do, even with AppArmor's restriction lifted) desktopd logs it and starts Chrome with `--no-sandbox`, leaving the container as the boundary (ADR 0002). Accepted as is: the container isn't loosened to get the sandbox. It answers JSON over HTTP on a Unix socket (`OPENBOT_DESKTOPD_SOCKET`, default `/run/openbot/desktopd.sock`, mode 0666), and writes the screens it keeps to `$OPENBOT_HOME/.openbot/screens.json`, restoring them when it starts. It imports nothing at runtime (Node's type stripping), so it starts before installs.
- **Crashes:** when a screen's Xvfb dies the whole screen restarts (new `startedAt`); when another of its programs dies only that one restarts. Delays grow from 250 ms to 10 s while it keeps crashing. A leftover Xvfb lock is cleared before a display starts.
- **Server:** `bots.displayNumber` is given at creation (highest + 1; bots made earlier get one on first use). Creating a bot starts its screen, deleting it stops the screen and deletes its profile, and on start the server syncs: every bot's screen started, screens of bots it no longer has stopped, retrying in the background while the daemon is not up. Neither create nor delete fails when the daemon can't be reached.
- **Streams:** `POST /api/bots/{botId}/screen/tickets` gives a random, single-use ticket valid for 30 s, kept in the server's memory. A WebSocket to `/api/screens/:botId/stream?ticket=…` is bridged byte for byte to the screen's x11vnc by the server itself (with `ws`), not by websockify; the Vite plugin in `vite.config.ts` attaches that upgrade handler in dev and preview. VNC ports listen on localhost only, so streams reach the owner only through the one port.
- **Screen pane** (the DM's default pane): noVNC, scaled to fit, view-only; **⤢ Open** shows it fullscreen, where the owner controls it (#42). View-only is enforced by the client (noVNC's `viewOnly`), not the server.
- **Seam 2:** `describeComputerContract` (`@openbot/core/testing`) runs against the fake (`fake-computer.test.ts`), against the daemon with stand-in programs on any machine (`apps/desktopd/src/daemon.test.ts`), and against the real daemon and shell in the runtime image (`computer.image.test.ts`). The browser joined the contract with #14.

As built (#14), computer-use sessions:

- `use_computer({ goal, reason, startUrl? })` is the bot's only way to its screen. Its surface is `computer_session`, so the orchestrator reviews the session as a whole and the audit log keeps the goal, the reason and the start URL, then each page it opens and its summary (#41, §5.2). It opens `startUrl` itself (once, even across a replay), then runs the session in a pi-durable conversation owned by the call (replay-safe: a rerun finds the same session), on `computerUseModel`, else the bot's own model, else `defaultModel` (#44). On a model that can't see images, `browser_screenshot` and `desktop_screenshot` take no screenshot and say so in text; the session works from snapshots. A bot's sessions run one at a time (one browser), and a session is stopped after 15 minutes.
- The session's conversation selects only the `computer-use` extension: its prompt (observe → act → verify; no secrets or purchases unless the goal says so; call `needs_help` when a login, captcha, 2FA or payment blocks it, see #16 below) and the browser tools `browser_snapshot`, `browser_navigate`, `browser_click`, `browser_type` (`submit` presses Enter), `browser_tabs` (list/new/select/close) and `browser_screenshot`, run one at a time. Actions return a fresh snapshot. The harness's default selection is the bots' own extension, so bots never have browser tools. Its final text is the summary; the call also takes a final screenshot, saved to `<bot folder>/screenshots/computer-<ms>.png` and returned as that path, not as an image (ADR 0008: images would flood the bot's history, and its model may not see them); the bot can `read` it or attach it. Nothing of the session is posted to the chat.
- The **browser** (`Browser` in core's `Computer` port; `connectBrowser` in `@openbot/computer`) speaks CDP to the screen's Chrome on `127.0.0.1:9222+display`, one WebSocket per bot with flat sessions per tab. Snapshots render Chrome's accessibility tree as `- role "name" [ref=eN]: value`, skipping the document, unnamed generic containers and text repeating its parent's name. References count up per bot and only the latest snapshot's work, and only on its tab: anything else is a `StaleRefError`. Clicks and typing are real input events (seen on the screen); an action that starts a page load waits for it (up to 15 s). A bot whose screen isn't running gets `BrowserUnavailableError`.
- **Seam 2:** the contract covers the browser (navigate, snapshot, type, click, stale references, tabs, screenshots, browsers kept apart, no screen), with test pages (`TestPage`) the fake shows as is and the real computer serves as HTML (`servePages`). `computer.image.test.ts` also runs a whole `use_computer` session with the fake model against a real Chrome.

As built (#15), desktop control:

- The **runtime image** installs cua-driver 0.38.0 (MIT) from trycua/cua's release for its architecture (amd64, arm64), in a build stage that checks the archive against SHA-256 hashes pinned in the Dockerfile and verifies its Sigstore bundle with cosign (itself pinned by SHA-256): the certificate must be issued to cua's `cd-rust-cua-driver.yml` workflow at that exact tag. Only the binary reaches the image. Cua's telemetry is off (`CUA_DRIVER_RS_TELEMETRY_ENABLED=0`). The image adds `at-spi2-core` and Mousepad (a small text editor, never restoring a session: screens stop without warning).
- **Each screen** also runs its own D-Bus session (`/tmp/openbot-dbus-N`), an accessibility bus (`at-spi-bus-launcher`, published on the display) and `cua-driver serve --socket /tmp/openbot-cua-driver-N.sock`, all as `openbot`, after Xvfb; Openbox and Chrome join the session, so apps on the screen show up in its accessibility tree. The driver's agent cursor shows the owner where it acts.
- The **desktop** (`Desktop` in core's `Computer` port; `connectDesktop` in `@openbot/computer`) talks MCP to the screen's driver through one `cua-driver mcp --socket` client per bot, run through `sudo -u openbot` because the driver answers only its own user. It lists windows, opens apps (and waits for their window), snapshots a window's accessibility tree with references counting up per bot (`- [ref=d12] button "Save"`; only the latest snapshot's work), and clicks, types, presses keys and scrolls by reference, by window, or at a point of the window's screenshot. Every action returns its **effect** (`confirmed`, `unverifiable`, `suspected_noop`, `partial`, `refused`) with the driver's summary; a stale reference is `refused` without being sent. Input goes in the background first; Xvfb has no device for focus-free input, so when the driver refuses for that it is sent again in the foreground (the window is activated, which is fine on the bot's own screen). Typing into what has focus always goes as real keys, so it replaces a selection.
- The `computer-use` extension gains `desktop_windows`, `desktop_open`, `desktop_snapshot`, `desktop_click`, `desktop_type`, `desktop_key`, `desktop_scroll` and `desktop_screenshot`; its prompt covers both, asking the session to trust only confirmed effects and to look again otherwise. Bots still never have these tools. A session's final screenshot is now of the whole screen.
- **Seam 2:** the contract covers the desktop (open and list, snapshot and type confirmed, click by reference, keys and focus typing, scroll, stale references refused as an effect, screenshots and points, desktops kept apart, no screen) against the fake's editor (`fakeEditor`) and, in the runtime image, real Mousepad through cua-driver; `computer.image.test.ts` also runs a whole desktop `use_computer` session with the fake model. `@openbot/computer`'s `desktop.test.ts` checks the client against a stand-in driver everywhere.

As built (#16), take-over:

- A session stuck on what only the owner can do (a login, a captcha, a 2FA code, a payment) calls its `needs_help({ instruction })` tool, which ends the session; the instruction is one line telling the owner what to do on the screen. `use_computer` finds that call in the session and, instead of a summary, posts a **take-over card** to the bot's DM (`messages.card = { type: 'take_over', instruction, goal }`; the goal is kept for the bot and not shown) and ends the bot's run, as `askQuestion` does. The sidebar shows the chat as waiting with the instruction. While a card waits, `use_computer` refuses to start, telling the bot to wait.
- The card (as in Grok, docs/grok-bot/05-ui.md §4.4): a status pill (Action needed / Done / Skipped), the instruction, and **✋ Take over**, which opens the screen fullscreen (#42), **I'm done** and **Skip**. Either of the last two calls `POST /messages/{id}/hand-back` with `done` or `skipped`, once (a second is a conflict): the server tells every tab through `message.updated`, and wakes the bot in the owner lane with the outcome, the instruction and the goal, so it calls `use_computer` again (or carries on without the step). A hand-back the bot couldn't be woken with is taken back. A handed-back card offers **Open screen**.
- **Seam 1:** `take-over.test.ts`.

As built (#42), take-over exactly as Grok does it (checked against Grok Bot 0.18's reconstructed source):

- **No holds.** Nothing pauses a bot's sessions while the owner is on its screen: as in Grok, a bot asks for help by ending its run, so nothing of it runs while the card waits. The owner's input and a session's can meet when the owner opens the screen while one runs; Grok accepts that. The hold endpoints from #16 are gone, and a session's 15 minutes are wall time again.
- **Pane** (docs/grok-bot/05-ui.md §4.1): view-only with **⤢ Open**, no Take over button. While a take-over card waits, a "Needs your attention" card above the screen shows the instruction with **Skip this step** and **I'm done, continue**, which hand back as the card's Skip and I'm done do.
- **Fullscreen** (§4.2): opening it is taking control: the screen is interactive at once, with keyboard focus in it. The card's Take over and Open screen open it too. While a card waits, a hand-off banner above the screen offers **Skip this step** and **I'm done, continue**: either sends the hand-back and leaves fullscreen without waiting. Leaving fullscreen hands nothing back (the card keeps waiting) and returns focus to the composer.
- **Waking the bot** uses Grok's resume prompts (`box-handoff-resume.ts`): after Done, call `use_computer` again starting with a screenshot; after Skip, treat the step as declined, don't ask for it again at once, and if the goal can't go on without it, say what is blocked and wait. Grok's server also knows a `viewer-closed` trigger, but its client never sends it, so OpenBot has none.
- **Not yet** (as in Grok): the wake lives in memory, so a restart between saving a hand-back and waking the bot leaves the bot asleep.

---

## 5. Agent runtime (offload to pi)

`@openbot/agent` is the only package that imports pi. All pi packages are pinned exactly, in lockstep (1.3.0).

| Need | pi piece |
|---|---|
| Durable runs, compaction, retries, usage, inbox | `pi-durable` Harness |
| Model access and provider login | `pi-ai` `Models` + our `CredentialStore` |
| Shell and files on the machine as `openbot` | `pi-env` daemon + `RemoteExecutionEnv` with pi-durable's built-in `bash`/`read`/`write`/`edit`; `openTerminal()` for a web terminal |
| MCP client, stdio and HTTP, OAuth | `pi-mcp` (+ `pi-mcp/oauth` with our `McpOAuthStateStore`) |
| Many tools without bloating the prompt | pi-durable `deferred` tools + `tool_search` |
| Orchestrator hook | `hook(ToolTask, { beforeTool })` |
| computerUse subagent | task-owned child conversation |
| Skills from plugins | `pi-coding-agent` `loadSkills` / `formatSkillsForPrompt` |

### 5.1 Providers and models

- Settings → Providers lists pi's providers. **Connect** runs `Models.login` on the server; its `AuthInteraction` prompts and events stream to a web wizard (`auth_url`, `device_code`, `secret`, `select`, `manual_code`). For loopback OAuth flows, the wizard asks you to paste the final redirect URL.
- Credentials live in our `CredentialStore`, backed by the encrypted `system_credentials` table. pi-ai refreshes OAuth tokens through it automatically. No API endpoint or tool ever returns system credentials.
- `settings` holds `defaultModel`, `computerUseModel`, `memoryModel`, `orchestratorModel`, `evalJudgeModel` (each "same as default" when null; for `computerUseModel`, the bot's own model before the default).

### 5.2 Orchestrator

```ts
interface Orchestrator {
  review(action: ProposedAction, ctx: ReviewContext): Promise<Verdict>
}
// surfaces: shell | computer_session | mcp | vault | plugin_request | routine_change | memory_shared_write
// (bot-to-bot messages are not reviewed)
type Verdict = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string; proposedRule?: string }
```

- Called from one `beforeTool` hook. Each tool declares its surface; read-only tools declare none (`null`), and so does messaging.
- Modes per surface: `off | shadow | enforce`, set globally and overridable per bot.
- **P0:** `AllowAllOrchestrator`, still writing every proposed action and verdict to the audit log.
- **P1:** `LlmOrchestrator` (Grok's recipe): the redacted action, the bot's instructions, last 2 user + 4 bot messages, and global + per-bot natural-language rules (≤ 20 each, "ask first" wins). Returns allow / deny / ask with a proposed rule. Errors or a 10 s timeout fall back to `ask` in enforce and `allow` in shadow. Ships in **shadow** everywhere.
- `ask` reuses the approval cards that the vault and plugins use. Vault and plugin approvals are hard-coded `ask` rules in front of the orchestrator.

As built (#41), the audit log (Grok's always-on action audit, apart from review):

- **Always on.** Every side-effecting tool call is written to the audit log whatever its surface's mode: `off` means not reviewed, not unrecorded, so its entry has no verdict (`null`). Each entry keeps the surface's mode for the bot at the time.
- **Kinds:** `action` (a tool call, with its input and verdict), `navigation` (a page a computer-use session's browser opened: `{ url, title }`, by the session tool that opened it: `use_computer` for its start URL, `browser_navigate`, a `browser_click` or `browser_type` that loaded a new page, `browser_tabs` opening a tab) and `session_summary` (once a session ends, however it ends: its outcome `done | needs_help | stopped`, its calls by tool, its screenshots including the final one, and its duration from its first start). Navigations and summaries are never reviewed; they sit under `computer_session`, whose review of the session covered them.
- Secrets are redacted from every entry as from reviews (`redactSecrets`). `bots.audit` lists all of them, oldest first; it is what the Activity pane will show.
- Secrets are also redacted from URLs: a password before the host, and `code`, `sig`, `signature`, `key`, `access_token` and `auth` query parameters.
- **Not yet:** MCP tool calls (server, tool, status, duration) join when plugins land (§5.5). A navigation is noticed from the page the session sees after an action, so a page that redirects on its own between actions shows only once the session looks again, and a page a click opens in another tab (`target=_blank`, `window.open`) isn't logged. The last page each session saw is kept in memory, so after a restart a session's first action only notes its page. A restart between writing an entry and its memo (the start URL's navigation, the summary) can write it twice. Navigations and summaries take the surface's mode when written, which may differ from the session's own entry if the owner changed it meanwhile.
- **Seam 1:** `orchestrator.test.ts` and `computer-use.test.ts`.

### 5.3 Memory (P1)

Grok Bot's memory (docs/grok-bot/03-agent-brain.md §4), in a table instead of files and without project memory. See ADR 0010.

- **Scopes:** *bot memory* (one bot's, deleted with it) and *shared memory* (every bot's, mostly about the owner; kept when its writer is deleted). No project or group-chat scope. Precedence: instructions > bot memory > shared memory, stated in the prompt.
- **Tiers:** `profile` (always in the prompt, never fades), `log` (dated, fades in ranking, kept), `note` (out of the prompt after 7 days, deleted by the next consolidation). **Episodes** are `log` facts in bot memory: extraction writes one sentence every 6 runs that sent a message or used a side-effecting tool.
- **`memories` table:** integer `id` (stable across edits), `scope` (bot | shared), `bot_id` (bot scope), `tier`, `content` (≤ 500 chars), `importance` (1–5), `source` (`owner` | `bot` with `source_bot_id` and a `source_bot_name` snapshot), `created_at`, `updated_at`. Every delete is a hard delete; edits replace in place. Bots never reach the table except through the tool below; memory is not in files under `$OPENBOT_HOME`.
- **Prompt:** the memory block comes last in the instructions, frozen per compaction epoch for prompt caching. Profile facts first (≤ 2k chars per scope; the lowest-importance profile facts drop out above that until consolidation shrinks it), then "Recently", both scopes ranked by `log2(importance) + createdAt / 30-day half-life`, ≤ 4k chars. Each line is `- [12] (learned 2026-10-25) fact`, shared facts tagged `[via Rex]`. Facts below the cut stay in the table and in the owner's UI; bots don't see them. There is no memory search tool. Owner edits and deletes break the freeze: affected bots re-render on their next run. Bots' own writes wait for the next compaction (they are in the history already).
- **Tool:** one `update_state` tool à la Grok, with the `memory` target only for now (`routine` joins with §5.4; a `profile` target is #51): `write { scope, tier, text, importance? }`, `edit { id, text?, tier?, importance? }` (no scope change: forget + write), `forget { id }`. Writes to shared memory are the `memory_shared_write` surface; bot-memory writes are not reviewed.
- **Ownership:** the bot always comes from the run's history, never from arguments. A bot reads and changes only its own bot memory and shared memory (it may edit or forget a shared fact another bot wrote). An id that doesn't exist, is gone, or is another bot's gets the same "no such fact" answer. The same check guards the tool, extraction, consolidation and the API, each with tests.
- **Extraction:** after every run settles, in every lane, a side call on `memoryModel` (trivial exchanges skipped). Per bot one at a time, in order; it doesn't block the next run. It sees the bot's current facts with ids and answers new facts (tier, scope, importance), `edit [id] …` or `remove [id]`. Facts about the owner come only from the owner's own words and go to shared memory; facts about the bot's work only from the bot's own messages. Tool results and other bots' words (group turns, bot-to-bot messages) are context, never a source. A failure is retried once, then skipped and audited. None runs while `memoryModel` has no working provider. Server jobs are audited, not reviewed.
- **Consolidation:** daily at 04:00 in the owner's time zone, only for scopes changed since the last run, on `memoryModel`: merge duplicates, promote recurring log/note facts to profile, delete expired notes, delete bot facts contradicted by newer shared ones, keep profiles under their cap. Answers in ids; a verification call rejects changes that drop or alter information. Every change is audited.
- **Owner UI:** the bot's **Memory** pane and Settings → **Shared memory** list facts by tier with source and date; add (importance 3 by default), edit, delete. No import or export.
- **Evals (`memory` suite):** a fact survives compaction; an owner-deleted fact is gone next run; a fact planted in a tool result is never stored; another bot's false claim about the owner in a group isn't stored; a shared fact reaches a second bot after its next compaction; instructions win over a conflicting memory.

### 5.4 Routines (P1)

- `routines`: bot, name, prompt, schedule (cron, `@daily`, `@every 15m`, one-off `at`), timezone, enabled, `next_run_at`, `created_by`.
- The server scheduler fires from `next_run_at`; each fire is a background-lane run in the bot's conversation, silence allowed. Missed fires under 1 h late run once on boot. An overlapping fire is skipped. `routine_runs` keeps history. Bots can create, update and delete routines.

### 5.5 Plugins (P1)

- **Format:** Claude Code plugins (`.claude-plugin/plugin.json`, `skills/*/SKILL.md`, `.mcp.json`).
- **Catalog:** bundled in `catalog/` and shipped with each release (Gmail, Drive, GitHub, Notion, ClickUp, Exa, …). Installed per instance into `$OPENBOT_DATA_DIR/plugins/`.
- **Accounts:** auth is app-wide, with several named accounts per plugin; the first is `default`. OAuth runs in your browser; API keys come through a secret-request card. All stored in `system_credentials`.
- **Grants** are per (bot, plugin, account). A bot asks with `request_plugin({ plugin, reason })`, which covers both install and access; the approval card has an account picker. One MCP server runs per (plugin, account), shared by all granted bots, with tools namespaced `mcp__<plugin>_<account>__<tool>` and offered as deferred tools. A plugin's skills come with any grant to that plugin.

### 5.6 Vault (P1)

- Items: `login` (domains, username, password, TOTP seed), `contact`, `secret`. AES-256-GCM in libSQL.
- `vault_search` returns metadata only. `vault_fill_login` makes the **server** type into the bot's focused Chrome field over CDP after checking the page origin; the bot never sees the password. `vault_read` returns contact and secret fields (secrets are redacted from logs).
- Approval card: Allow once / Always for this bot / Deny, stored as per-item grants. Bots can propose new items through a save card. Every use is written to a hash-chained audit log.

---

## 6. UI

The UI copies Grok Bot's; the full spec is [`grok-bot/05-ui.md`](grok-bot/05-ui.md).

- Three columns: resizable sidebar (280px, 240–400), a centred chat (≤ 690px messages), and one right-hand pane at a time (320px, 280–480).
- Header icons pick the pane: **Screen** (default), **Profile** (Grok's fields + Model), **Routines**; **Memory**, **Access** (plugin accounts and vault items, with revoke) and **Activity** (audit + orchestrator mode and rules) are under "⋯". Groups get a **Members** pane.
- Settings: Providers, Models, Plugins, Vault, Shared memory, Global rules, Updates, System (displays, disk, logs, terminal).
- Grok's visual language: black/white primary buttons, blue only for links/focus/unread, no shadows in dark mode, autosave instead of Save buttons, letter keys for question cards.

---

## 7. Code layout

```
apps/
  webapp/        TanStack Start: UI, /api/* (oRPC), /api/events (SSE), screen-stream proxy; starts the runtime
  desktopd/      Display manager daemon (runs as openbot)
  mobile/        Expo app (P2)
  site/          Astro marketing site
packages/
  db/            Drizzle schema + migrations
  core/          Domain services and ports; no UI, no pi
  agent/         pi integration, tools, prompts, Orchestrator, computerUse subagent
  plugins/       Catalog, installs, accounts, grants, MCP manager, skills
  vault/         Encryption, items, grants, fill-login
  computer/      desktopd client, CDP browser tools, cua-driver proxy
  api-contract/  oRPC contract (zod) + typed client helpers for web and mobile
  ui/            shadcn components + Grok design tokens
catalog/         Bundled plugins
evals/           Scenarios, fake world, runner
docker/          Runtime Dockerfile, supervisord, entrypoint, compose samples
scripts/         install.sh, release packaging
```

- **API:** oRPC, contract-first. Plain HTTP with a generated OpenAPI spec, TanStack Query on web and mobile, and one SSE event stream with `{epoch, seq}` stamps for reconciliation.
- **Dependencies:** `db` ← `core` ← `agent` / `plugins` / `vault` / `computer` ← `webapp`.
- **Env:** `@t3-oss/env-core` + zod per package; scripts run through `dotenv -e ../../.env`.

---

## 8. Evals

Developer-only. YAML scenarios in `evals/` define setup (instructions, model, plugins, vault, memory), a fake world (fake MCP servers, browser, computer and clock), a script of user messages, and assertions: deterministic checks (`tool_called`, `tool_not_called`, `approval_requested`, `no_secret_in_context`, message counts) plus LLM-judge rubric items on `evalJudgeModel`. `pnpm eval [suite] --model X --runs 3` reports pass rates; CI runs a smoke suite on each push to `main`.

First suites: `tool-priority`, `voice`, `vault`, `routines`, `groups`, `memory`.

As built (#21):

- **`evals/`** is the `@openbot/evals` workspace package: scenarios in `evals/suites/<suite>/<scenario>.yaml`, the runner in `evals/src`. Usage and the scenario format: `evals/README.md`. The first suites are `tool-priority`, `voice` and `groups` (three scenarios each); `vault`, `routines` and `memory` wait for those features (P1), and so do the `approval_requested` and `no_secret_in_context` assertions.
- **Each run** starts a fresh server through Seam 1's harness (`@openbot/webapp/testing`): the real router, `BotRuntime` and pi-durable over a temporary database, with the fake computer as the world. The world is scripted shell results (regex → stdout; `world.clock` answers `date`, the bots' only clock since prompts carry no date), fake browser pages, and fake tool servers' tools (`world.tools`, surface `mcp`, standing in for plugins). The owner's messages go through `chats.send` and `groups.create`; the next waits until no bot works and no group plays rounds. Then the runner reads every chat's messages and each bot's tool calls (`BotRuntime.toolCalls`, from its history), checks the assertions (`tool_called`, `tool_not_called`, `tool_order`, `messages`, `max_message_length`, `no_silent_answer`), and asks the judge model to score the rubric items (JSON verdicts; anything unreadable fails).
- **Models.** `--model provider/model` (or `OPENBOT_EVAL_MODEL`) runs bots on a real model, and the judge is `--judge` (or `OPENBOT_EVAL_JUDGE_MODEL`, else the same model). The runner loads pi's built-in providers and connects each one a scenario needs with `Providers.connectFromEnv`, which reads the provider's usual API key variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`…) from the environment it is given and stores it like an owner's key; the server itself still never reads keys from its environment. `evalJudgeModel` is not a setting: evals are developer-only. Without a model the runner uses the **faux** model: each scenario's `faux` script plays a well-behaved bot and a stand-in judge passes every rubric item, which checks the scenarios and the pipeline, not a model; `evals/src/suites.test.ts` runs every scenario that way in `pnpm test`.
- **Running it.** `pnpm eval` is `node --experimental-transform-types evals/src/cli.ts`: plain type stripping can't load the workspace sources it imports (parameter properties in `@openbot/core` and the agent's fakes). Without a model it says so in the report's title, and `--record-baseline` refuses: faux rates measure scripts, not a model. Releases carry `evals/` only so the workspace installs as its lockfile says.
- **Pass rates.** A run passes when every assertion and rubric item does; a scenario's pass rate is over its runs, a suite's is its scenarios' mean. `pnpm eval` prints a Markdown report (`--report`, `--json` to save it). `--record-baseline` writes the rates to `evals/baselines/<model>.json`, and later runs on that model show them beside their own, marking drops.
- **CI.** The release workflow's `evals` job runs `pnpm eval smoke` on pushes to `main` and manual runs when the repository variable `OPENBOT_EVAL_MODEL` is set (with the provider's key as a secret), and skips with a notice otherwise. It never blocks the release: `publish` adds its report to the release notes, or says it didn't run.

---

## 9. Mobile (P2)

Expo app over the same oRPC API and SSE stream: bots, groups, chat, cards and approvals, a view-only computer preview, and Expo Push notifications. Dictation uses on-device Whisper (`whisper.rn`, model downloaded on first use); the webapp's mic uses whisper WASM. The phone must reach the instance's private network.

---

## 10. Build order

1. **`db`**: schema update for these decisions (`settings`, `system_credentials`, unified `bots.pi_conversation_id`, hard-delete cascades, `author_name`, group rules, `kind` on conversations).
2. **`core` + `agent`**: harness, CredentialStore, sendMessage + reply guarantee, turn manager and lanes, groups, `message_bot`, Orchestrator port. **Evals** fake world and first suites alongside.
3. **`computer` + `desktopd` + runtime image**: displays, noVNC, pi-env as `openbot`, CDP tools, cua-driver, computerUse subagent.
4. **`api-contract` + `webapp`**: onboarding and provider wizard, sidebar, chat, cards, panes.
5. **Release pipeline + installer + dev compose.** → **P0 done.**
6. P1, in order: memory, plugins, sections, palette/search; then routines, vault, `LlmOrchestrator`, secrets broker, notifications, site.
7. P2: mobile, rich renderers, animated avatars.
