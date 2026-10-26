# Grok Bot: feature inventory (high level)

> Positioning from xAI: *"An agent with a computer."* Your team of always-on agents that finish the work. Bots sign into the tools you already use, work across apps, inboxes and websites (including ones with no API or MCP), keep running while you're away, and contact you only when they need a judgment call.
>
> Availability: beta, included with SuperGrok / SuperGrok Plus / Heavy and Cursor Pro / Pro+ / Ultra / Teams. Desktop (macOS, Windows) and iOS. Bot usage is metered separately from Grok and Cursor usage.

Each section below gives what the feature is and the main code paths behind it. Paths are relative to `source/` or to `frontend/src/recovered/features/`.

---

## 1. Bots (agents)

| Feature | Description | Code |
|---|---|---|
| **Multiple named Bots** | Each Bot is a long-lived conversation with a **name, title, description (persona)**, avatar, settings, its own memory, its own routines, and private skills. | `host/agents/*`, `agent-info/settings/*` |
| **Bots create Bots** | Agents can spawn teammates with `CreateAgent` and edit them with `UpdateAgent`. Only the user can delete a Bot. | `host/runner/tools/sand-agent-management-tools.ts` |
| **Bot ↔ Bot messaging** | `SendToAgent` is fire-and-forget. It wakes the recipient, and `priority=true` interrupts the recipient's current non-user turn. | `host/agents/agent-messaging.ts` |
| **Onboarding personas** | About 40 suggested starter Bots, such as Chief of Staff, Inbox Triage, Night Shift, Competitor Watcher, Researcher, QA Engineer and Paralegal. The flow starts with a "What do you use every day?" tool picker. | `onboarding/signed-in/*` |
| **Avatar editor** | Upload, crop or zoom an image, or generate one from a prompt. Bots can also set their own avatar. | `agent-info/avatar-editor/*` |
| **Sidebar / roster** | Live status (running, needs attention, unread), pinning, user-named sections, multi-select, duplicate, rename, hide, and **Broadcast** (one message to many Bots). | `frontend/src/production/sidebar-model.ts` |
| **Hidden Bots** | A hidden Bot keeps running and keeps its history. It just doesn't appear in the sidebar or send notifications. | `hidden-chats/*` |
| **Org chart / Agent network** | A live graph of Bots and groups. Edges show membership and who talks to whom, and nodes show idle, typing or working. Behind an experiment flag. | `org-chart/workspace/*` |

## 2. Conversations and chat UX

| Feature | Description |
|---|---|
| **Rich composer** | Rich text (TipTap), file drag/drop/paste, **voice input** (transcribed via the Cursor backend), and `@mentions` of Bots, skills, MCP connectors and PRs. You can reply to a specific message, and drafts are kept per chat. |
| **"Texting" model** | A Bot replies in several short bubbles through `SendMessage`. Its reasoning and tool output are never shown. |
| **Transcript rendering** | Markdown, KaTeX math, Mermaid, code blocks, link previews, inline image and video, plus built-in **PDF, spreadsheet (CSV/XLSX) and media viewers**. Also find-in-chat and a conversation outline. |
| **Threads** | Messages can carry `reply_to` threads ("N in thread"). Bots use them only to move secondary bulk out of the main flow. |
| **Reactions** | The user gets an emoji picker. A Bot can tap back with `ReactToMessage`, which it is told to use rarely. |
| **Question widgets** | A Bot asks for a decision with a card of 1–6 options. Options can be styled default, primary or danger, and a free-text answer is optional. Asking a widget ends the Bot's turn. |
| **Rich cards** | Email draft, Slack draft, connector OAuth, "link GitHub/Slack" listener, **secret request** (the value is never shown to the agent), local-command permission, auto-review approval, Cursor cloud-agent (Open in Cursor / View PR), and timeline events. |
| **Async tasks pane** | Lists in-flight background subagents and cloud agents. |

## 3. Groups, shared rooms, channels

| Feature | Description |
|---|---|
| **Group chats** | A chat made of your Bots. It runs in **rounds**: at most 3 rounds and 10 member turns, with speaker order rotated each round. `@name` or `@everyone` picks who answers, and a member can reply "(pass)". Groups can't contain groups. Members keep their full toolkit, but their private 1:1 context is not revealed. |
| **Cross-user shared rooms** | A group can be shared with **other people**, who bring their own Bots. Guests join with a room link via Cmd-K, and the host approves each one. Strict guardrails apply: only `SendMessage` text leaves your machine, memory, files and connector data are never revealed, and destructive requests from non-owners are refused. |
| **Channels** | Connect a Bot to Slack or Discord so it receives inbound messages and replies there. This is "coming soon" in 0.18. |

## 4. Grok Bot's Computer (the cloud "box")

| Feature | Description |
|---|---|
| **One persistent cloud VM per user** | All of a user's Bots share **one Linux VM**: one filesystem, one set of installed tools, and **one signed-in Chrome**. Each Bot gets its **own desktop/window**. Logins are shared across Bots. |
| **Watch it live (VNC)** | Embedded VNC viewer with a preview in the chat, fullscreen, and a "More screens" strip. Banners show booting, setup and "needs your attention". |
| **Hand-off / take over** | For login, 2FA, captcha or payment, a Bot calls `request_box_help`. You take over the desktop, finish the step, and hand it back. The Bot never sees the credentials, and the login persists for later. |
| **Forever box** | **Update** recreates the VM on a new image and keeps your data; it can wait until agents are idle or run automatically when idle. **Reset** rebuilds from the last snapshot. A disk-pressure guard watches storage. |
| **Durable home** | `/home/box`, including the Chrome profile, is snapshotted to object storage, so logins and files survive a rebuild. |
| **Environment secrets** | Up to 100 user env vars are injected into the VM. Their values are redacted from tool output. |
| **Egress via desktop** | Option to route the VM's web traffic out through your own computer, so it uses your own IP. |
| **Hardware security keys** | The VM's Chrome can use a YubiKey plugged into your computer (WebAuthn proxy). Each use needs your approval. |
| **Time-of-day wallpaper** | The VM desktop wallpaper follows your time zone. [inferred: from the scheduler code; no UI was seen] |
| *Local Docker VM* | *Reconstruction-only:* runs the box in a local container instead of the cloud VM. |

## 5. What a Bot can do (capabilities)

| Capability | Description |
|---|---|
| **Shell and files on its VM** | `Shell`, `Read` and `AwaitShell`. Commands can run in the background, and the Bot is notified when they finish. `CopyToBox` / `CopyFromBox` move files between your computer and the VM. |
| **Commands on *your* computer** | `ExternalShell` / `ExternalRead`, through a local daemon. Each action is gated by **Always allow / Ask every time / Never** (default: ask). A team admin can cap the choice. |
| **Browser automation** | 15 `browser_*` tools on the VM's signed-in Chrome: navigate, snapshot with element refs, click, type, fill, CDP and more. They run in a `browserUse` subagent. |
| **Computer use** | A `Computer` tool (click, type, scroll, key, drag, plus a screenshot after every action) runs in a `computerUse` subagent. The main agent watches through `Screenshot`. |
| **Subagents / multitask** | `Task` dispatches background subagents (explore, executor, watchVideo, computerUse, browserUse and others). `CheckSubagent`, `MessageSubagent` and `StopSubagent` manage them. In "multitask" mode the main Bot acts as a dispatcher for parallel executors. |
| **Code changes via Cursor** | Non-trivial repo work goes to a **Cursor cloud agent** (`CloudAgent` tool), which opens a PR. Bots are told *never* to clone repos themselves. |
| **Web** | `WebSearch` and `WebFetch`, both run by the Cursor backend. |
| **Image generation** | `GenerateImage`, with aspect ratios and reference images. |
| **MCP connectors** | `GetMcpTools` / `CallMcpTool`, multiple accounts per connector (for example work and personal Gmail), and per-connector custom instructions. |
| **Self-management** | Bots can search, install and uninstall plugins and MCP servers themselves, after confirming with you. `update_state` edits their own memory, routines, skills, profile, settings, projects and avatar. |

## 6. Memory, skills, projects, teaching

| Feature | Description |
|---|---|
| **Memory** | File-based memory in three **scopes**: the Bot's own, **user** memory shared by all your Bots, and **project** memory. It has three **tiers**: `profile` (foundational, always in context), `log` (dated history) and `note` (short-lived). After every turn an LLM pass extracts facts, every 6 turns it writes an episode journal entry, and a background job consolidates memory daily ("dreaming"). |
| **Projects** | A shared folder plus memory space that several Bots can join. |
| **Skills / workflows** | Reusable `SKILL.md` files shared across **all** your Bots. Sources are user-created, plugin, managed by Cursor, or published by your team. Reference one in the composer with `@skill`. Skills can be enabled per Bot. |
| **Teach a task** | Record yourself doing a task on the VM desktop. The Bot watches the recording with a `learn-from-demonstration` skill and saves it as a reusable workflow. |
| **Team rules** | Cursor team rules that target Grok Bot are injected into prompts. |

## 7. Routines (automations)

| Feature | Description |
|---|---|
| **Routines** | A saved prompt to the Bot's future self plus one or more triggers. The UI has a list, a detail page, "Test run", pause and resume, and **run history**. Bots create routines themselves with `update_state`. A run wakes the Bot silently (a `[routine]` cue), and it may stay silent if there's nothing to report. A spend guard caps cost. |
| **Schedules** | 5-field cron, `@daily`-style aliases, `@every 15m`, and `CRON_TZ=` prefixes, all in your time zone. The backend fires them, not the desktop. |
| **Event triggers** | **GitHub**: PR opened, pushed, merged or reviewed; comments; CI passed or failed. **Slack**: mention, keyword or reaction. **Teams**: regex match. **Linear**, **Sentry** and **PagerDuty**: issue and incident lifecycle. Up to 8 listeners can be combined with OR. |

## 8. Plugins, MCP, hooks

| Feature | Description |
|---|---|
| **Plugin marketplace** | Bundles of connectors (MCP servers) and skills. Tabs for Marketplace and Installed. Ownership badges show team-added, Cursor-managed or local plugins, and plugins can be installed from a deep link. Plugin content is fetched by git sparse clone onto the VM. |
| **MCP OAuth** | The authorization flow runs in your browser and returns through a loopback callback. In the chat it shows as a "Connect / Authorized" card. |
| **Hooks** | Cursor- and Claude-Code-compatible hooks, such as `beforeShellExecution`, `preToolUse`, `stop` and `preCompact`. There is a mapper from Claude Code hook configs. |

## 9. Safety and permissions

| Feature | Description |
|---|---|
| **Auto-review** | An AI classifier reviews risky actions before they run. That covers VM shell, your-machine shell, MCP calls, clicks, browser actions, cloud-agent launches and subagent launches. Each surface is off, shadow or enforce. A blocked action can be escalated as an **approval card**, with at most 4 pending per Bot and a 10-minute TTL. |
| **Auto-review rules** | Up to 20 natural-language rules you write, each either "Allow automatically" or "Ask first". "Ask first" wins conflicts. |
| **Spotlighting** | Tool results are wrapped in `<cursor_untrusted_data_1337>` fences, and the model is told that fenced content is data, never instructions. This is the prompt-injection defense. |
| **Local permission dock** | "Allow Grok Bot to run commands on your local computer?" with Allow once / Always / Deny. |
| **Action audit log** | Every action is written to a local JSONL log and sent to the backend in batches. |

## 10. App shell

| Feature | Description |
|---|---|
| **Notifications** | OS notifications ("<Bot> needs you" or a turn preview) throttled to one per 5 s, mobile push when you've been away from the desktop, a dock badge, and in-app **error trays** with a request ID. |
| **Cmd-K palette** | Agents, groups, actions, messages, files, links and routines. Also "Join shared room". |
| **Global search** | Full-text search across all chats, served by an index on the VM. |
| **Deep links** | `sand://app/v1/{info,open,plugin-add}` and `cursor.com/sand/link/…` |
| **Account and access** | Sign in with Cursor. An access cover explains a block: privacy mode, missing seat, trial or paywall. |
| **Usage & billing** | Weekly usage %, trial usage, and on-demand spend. |
| **Settings** | Appearance, time zone, local execution, Computer (reset, update, egress, security keys), auto-review rules, updates (stable, dogfood) and usage. |
| **Feedback** | Feedback is sent with the conversation ID and Sentry IDs attached. |

---

## Concepts at a glance

```
User ──┬── Bot A (persona, memory, routines) ──┐
       ├── Bot B ──────────────────────────────┼── one shared cloud VM ("box")
       ├── Bot C ──────────────────────────────┘     • shared FS + signed-in Chrome
       ├── Group (A+B+C, round-based)                • per-Bot desktop window
       └── Shared room (Group + other users' Bots)   • VNC for the user to watch / take over
                                                     
Each Bot reaches: its VM (Shell/Read/browser/computer) · your Mac (ExternalShell, permissioned)
                  MCP connectors · web · Cursor cloud agents · other Bots (SendToAgent)
Wakes on: your message · routine schedule · GitHub/Slack/Linear/... event · another Bot · background job done
```

## Things worth copying for openbot

1. Make **Bots first-class entities**, each with a persona, memory and routines. Let Bots create Bots and message each other.
2. Give every user **one persistent sandbox computer** with a browser and desktop the user can watch and take over. Persistent logins are the main source of value here.
3. Use **`SendMessage` as the only voice.** It gives you a multi-bubble, human-feeling chat and hides tool noise.
4. **Routines** = a prompt plus triggers (cron and webhooks). The Bot creates them itself.
5. Put a **safety layer on side effects** (a classifier plus approval cards) and use **untrusted-content fencing**.
