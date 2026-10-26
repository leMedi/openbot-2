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
| Memory | | Global + per-bot, tiers, extraction, consolidation | |
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
- **No auth for now.** The host is private and reached over Tailscale. The compose sample includes an optional Tailscale sidecar (`tailscale serve`) for HTTPS on the tailnet, which the browser needs for clipboard and microphone.
- One container runs everything under supervisord:
  - `openbot` server (TanStack Start): UI, `/api/*`, SSE, `/vnc/:botId` proxy, agent runtime, scheduler, MCP manager. Runs as user `openbot-server`.
  - `openbot-desktopd`: owns every bot's Xvfb, Openbox, Chromium, websockify and cua-driver. Runs as user `openbot`. Talks to the server over a Unix socket. Displays survive server restarts.
  - pi-env daemons, spawned by the server as user `openbot`, run bots' shell and file tools.
- Bots have **full passwordless sudo**: it is their computer.

### 2.2 Known risks (accepted for now)

1. **Bots can call the API.** With no auth, anything that reaches the port is the owner, including a bot's shell. Fix later: `iptables -m owner --uid-owner openbot` reject on the server port.
2. **Bots with root can read secrets.** The vault, provider tokens and MCP credentials are encrypted, but the key is on the same machine. **P1:** move secrets and the key into a small secrets-broker container that only the server can call.

### 2.3 Paths and environment

Only values needed before the database opens are env vars. Everything else lives in the `settings` table.

| Env var | Default | Holds |
|---|---|---|
| `OPENBOT_DATA_DIR` | `/var/lib/openbot` | libSQL db, pi-durable storage, plugin installs, audit log. Mode 0700, server user only. |
| `OPENBOT_HOME` | `/home/openbot` | Bots' world: `shared/`, `bots/<id>/` (workspace, uploads, Chromium profile), installed tools |
| `OPENBOT_APP_DIR` | `/opt/openbot` | `releases/<version>/`, `current` symlink |
| `OPENBOT_SECRET_KEY` | generated on first boot | Encryption of vault and system credentials |
| `OPENBOT_PUBLIC_URL`, `OPENBOT_PORT` | `3000` | Links and OAuth redirects |
| `OPENBOT_DEV` | unset | Dev mode: disables the updater |

The compose sample mounts three named volumes: `openbot-data`, `openbot-home`, `openbot-app`. Only one port is exposed; noVNC goes through the server.

### 2.4 Updates and versioning

- **Runtime image** (`ghcr.io/<owner>/openbot-runtime:r<N>`): Ubuntu, Node, Chromium, Xvfb, Openbox, noVNC, supervisord, cua-driver (pinned, sigstore-verified). Rebuilt only when `docker/**` changes. Updated with `docker compose pull && up -d`.
- **App releases**: every push to `main` builds `0.<minor>.<run>` (minor from the `VERSION` file). The GitHub Release carries the app tarball, `SHA256SUMS`, `release.json` (version, `minRuntime`, migrations, changelog) and `install.sh`. The image also embeds the release it was built with.
- **Updater** (Settings → Updates; manual, notify or auto-when-idle): download, verify sha256, run migrations, quiesce (stop new runs; pi-durable resumes in-flight ones), swap the `current` symlink, restart only the server, health-check, roll back on failure. Refuses releases whose `minRuntime` is newer than the running image.

### 2.5 Installer

`curl -fsSL https://openbot.lemedi.dev/install.sh | bash`. The domain comes from `OPENBOT_SITE_URL` in shared repo config and a GitHub Actions variable.

1. Check Linux x86_64/arm64, Docker and Compose v2. Offer `get.docker.com` if Docker is missing.
2. Ask (or take flags): install dir (`~/openbot`), port, Tailscale sidecar and auth key.
3. Write `docker-compose.yml` and `.env` (generated secret, pinned runtime tag).
4. `docker compose pull && up -d`, wait for `/api/health`, print the URL.

Re-running never overwrites `.env`; it offers a runtime update. Flags: `--yes --dir --port --tailscale-key`.

### 2.6 Dev setup

`docker/compose.dev.yml` uses the same runtime image with a `dev` target (pnpm, build tools). The repo is bind-mounted at `/opt/openbot/current`, `node_modules` lives in a named volume, and supervisord runs `pnpm dev` (Vite HMR, `tsx watch` for desktopd). Separate dev volumes. Commands: `pnpm dev:up`, `dev:sh`, `dev:reset`, `dev:seed`. An optional `.devcontainer/` points at the same compose file. Evals run on the host.

---

## 3. Bots, conversations and groups

### 3.1 Bots

- Fields: name (unique ignoring case; bots are mentioned by name), title, instructions, avatar shape and color, `model` (null follows `settings.defaultModel`), display number, `pi_conversation_id`, sidebar `section_id` and `pinned_position` (P1).
- **New bot** opens a popup with those fields. **New group chat** opens an empty conversation with a Slack-style "To:" chip field; the first message creates the group.
- **Delete is permanent.** It removes the bot row, its pi conversation, 1:1 messages, routines, memory, grants, rules, audit entries, display and `$OPENBOT_HOME/bots/<id>/`, and removes it from groups. Messages it left elsewhere keep an `author_name` snapshot and show as "Name (deleted)". Global memory facts it wrote stay.

### 3.2 One conversation per bot (Grok's model)

Each bot has **one unified pi-durable conversation** (this supersedes the earlier one-conversation-per-group decision). Every input reaches it with a tag:

| Input | Lane | Shape |
|---|---|---|
| Your message in the 1:1 | user | plain user message |
| Group turn | user | `[Group chat: "Launch" - with Ana, Rex]` + messages since it last spoke (≤ 24) |
| Another bot's message | agent | hidden `[agent]` cue, silence allowed |
| Routine fire | background | hidden `[routine: name]` cue, silence allowed |
| Subagent / background completion | background | revival turn |

One active run per bot, lanes ordered user > agent > background. Interrupts steer by default (pi-durable inbox + a `sendMessage` guard) and abort only on Stop or timeout.

### 3.3 The bot's voice

The model's plain text is private. The only way to reach you is `sendMessage` (several short bubbles, attachments, question widgets, cards). If a run that answers your message ends without a `sendMessage`, a reminder forces a reply (Grok's reply guarantee).

### 3.4 Groups

Grok's rules: at most 3 rounds and 10 member turns per human message, speaker order rotates each round, `@name` / `@everyone` picks responders, `(pass)` means silent, at most 2 messages per member turn, and members never reveal private 1:1 context. The older `maxRunsPerBot` / `maxTurnsPerMessage` columns are replaced by these.

### 3.5 Bot ↔ bot (Grok's `SendToAgent`)

`message_bot({ to, text, images?, priority? })` is asynchronous and returns immediately. `to` is a bot or a group the sender belongs to. The sender's chat gets an outgoing entry and the recipient's chat an incoming entry; there are no separate bot-to-bot conversations. The recipient wakes in the agent lane; `priority` interrupts its current non-user run. Prompt rules are copied from Grok: use sparingly, fan out only on request, never relay your venting verbatim, no acknowledgement ping-pong.

---

## 4. The bot's computer

- **One X display per bot, always on.** Xvfb at 1280×800 + Openbox + its own Chromium profile at `$OPENBOT_HOME/bots/<id>/chromium` (logins are not shared between bots). Display numbers are stable per bot.
- **noVNC** per display, proxied at `/vnc/:botId`. The Screen pane shows a view-only preview; ✋ switches to interactive with "Hand back"; ⤢ opens fullscreen.
- **Tool priority**, stated in the prompt: plugin/MCP → shell and web fetch → browser → desktop.
- Browser and desktop tools live only in a **computerUse subagent** (a pi-durable task-owned conversation running `computerUseModel`). The main bot calls `use_computer({ goal, reason, startUrl? })`; the reason is logged and scored by evals. Its activity is hidden in the chat, like Grok's.
  - **Browser:** our own CDP tools (`browser_snapshot` with `[ref=eN]`, click, type, navigate, tabs, screenshot).
  - **Desktop:** cua-driver (MIT), one per display, over MCP: accessibility tree with element tokens, then act, then verify the effect.
- When stuck (login, captcha, 2FA) the subagent returns `needs_help` and the bot posts a **Take over** card that opens noVNC; the bot waits for "Done".

---

## 5. Agent runtime (offload to pi)

`@openbot/agent` is the only package that imports pi. All pi packages are pinned exactly, in lockstep (1.3.0).

| Need | pi piece |
|---|---|
| Durable runs, compaction, retries, usage, steering inbox | `pi-durable` Harness |
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
- `settings` holds `defaultModel`, `computerUseModel`, `memoryModel`, `orchestratorModel`, `evalJudgeModel` (each "same as default" when null).

### 5.2 Orchestrator

```ts
interface Orchestrator {
  review(action: ProposedAction, ctx: ReviewContext): Promise<Verdict>
}
// surfaces: shell | computer_session | mcp | vault | plugin_request | routine_change | memory_global_write
// (bot-to-bot messages are not reviewed)
type Verdict = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string; proposedRule?: string }
```

- Called from one `beforeTool` hook. Each tool declares its surface; read-only tools declare `none`.
- Modes per surface: `off | shadow | enforce`, set globally and overridable per bot.
- **P0:** `AllowAllOrchestrator`, still writing every proposed action and verdict to the audit log.
- **P1:** `LlmOrchestrator` (Grok's recipe): the redacted action, the bot's instructions, last 2 user + 4 bot messages, and global + per-bot natural-language rules (≤ 20 each, "ask first" wins). Returns allow / deny / ask with a proposed rule. Errors or a 10 s timeout fall back to `ask` in enforce and `allow` in shadow. Ships in **shadow** everywhere.
- `ask` reuses the approval cards that the vault and plugins use. Vault and plugin approvals are hard-coded `ask` rules in front of the orchestrator.

### 5.3 Memory (P1)

- `memories` table: `scope` (global | bot), `bot_id`, `tier` (profile | log | note), `content` (≤ 500 chars), `importance` (1–5), `source_bot_id`, `created_at`, `last_used_at`, `superseded_by`.
- Prompt: profile facts plus a "Recently" block ranked by importance and 30-day decay (≤ 4k chars), frozen per compaction epoch for prompt caching.
- Writes: `memory_write` / `memory_forget` (own and global; global facts are tagged `[via Bot]`), a post-turn extraction call on `memoryModel`, and a daily consolidation job. `memory_search` uses FTS5; vectors can come later.

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
- `vault_search` returns metadata only. `vault_fill_login` makes the **server** type into the bot's focused Chromium field over CDP after checking the page origin; the bot never sees the password. `vault_read` returns contact and secret fields (secrets are redacted from logs).
- Approval card: Allow once / Always for this bot / Deny, stored as per-item grants. Bots can propose new items through a save card. Every use is written to a hash-chained audit log.

---

## 6. UI

The UI copies Grok Bot's; the full spec is [`grok-bot/05-ui.md`](grok-bot/05-ui.md).

- Three columns: resizable sidebar (280px, 240–400), a centred chat (≤ 690px messages), and one right-hand pane at a time (320px, 280–480).
- Header icons pick the pane: **Screen** (default), **Profile** (Grok's fields + Model), **Routines**; **Memory**, **Access** (plugin accounts and vault items, with revoke) and **Activity** (audit + orchestrator mode and rules) are under "⋯". Groups get a **Members** pane.
- Settings: Providers, Models, Plugins, Vault, Global memory, Global rules, Updates, System (displays, disk, logs, terminal).
- Grok's visual language: black/white primary buttons, blue only for links/focus/unread, no shadows in dark mode, autosave instead of Save buttons, letter keys for question cards.

---

## 7. Code layout

```
apps/
  webapp/        TanStack Start: UI, /api/* (oRPC), /api/events (SSE), /vnc proxy; starts the runtime
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

---

## 9. Mobile (P2)

Expo app over the same oRPC API and SSE stream: bots, groups, chat, cards and approvals, a view-only computer preview, and Expo Push notifications. Dictation uses on-device Whisper (`whisper.rn`, model downloaded on first use); the webapp's mic uses whisper WASM. The phone must be on the tailnet.

---

## 10. Build order

1. **`db`**: schema update for these decisions (`settings`, `system_credentials`, unified `bots.pi_conversation_id`, hard-delete cascades, `author_name`, group rules, `kind` on conversations).
2. **`core` + `agent`**: harness, CredentialStore, sendMessage + reply guarantee, turn manager and lanes, groups, `message_bot`, Orchestrator port. **Evals** fake world and first suites alongside.
3. **`computer` + `desktopd` + runtime image**: displays, noVNC, pi-env as `openbot`, CDP tools, cua-driver, computerUse subagent.
4. **`api-contract` + `webapp`**: onboarding and provider wizard, sidebar, chat, cards, panes.
5. **Release pipeline + installer + dev compose.** → **P0 done.**
6. P1: memory, routines, plugins, vault, `LlmOrchestrator`, secrets broker, sections, palette/search, notifications, site.
7. P2: mobile, rich renderers, animated avatars.
