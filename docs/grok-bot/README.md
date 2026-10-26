# Grok Bot teardown

This is research for openbot. It analyses xAI's **Grok Bot** ([x.ai/bot](https://x.ai/bot)) using its public material and the source-level reconstruction of the 0.18.0 macOS app at `/Users/lemedi/learn/grok-bot-0.18-reconstructed-main`.

| File | What it covers |
|---|---|
| [01-features.md](01-features.md) | High-level inventory of every feature the product ships |
| [02-architecture.md](02-architecture.md) | Internal mechanics: processes, the cloud "box", persistence, extensions, auth, inference backends |
| [03-agent-brain.md](03-agent-brain.md) | The agent itself: system prompt, tools, step loop, memory, context compaction, safety, models |
| [04-prompt-lifecycle.md](04-prompt-lifecycle.md) | Step-by-step walkthrough of one prompt, from keypress to rendered reply |
| [05-ui.md](05-ui.md) | UI/UX spec of the desktop renderer: layout, sidebar, chat, cards, computer view, panels, design tokens, rebuild checklist |

## TL;DR

- **What it is.** You get a roster of always-on, named agents ("Bots"). Each Bot has a persona, its own memory and its own routines. All of your Bots share **one persistent cloud Linux VM** (the "box", shown to users as "Grok Bot's Computer"). The VM has a desktop, a terminal and a signed-in Chrome. Each Bot gets its own screen on it, and you can watch over VNC.
- **Who built it.** It is built by Anysphere (Cursor), and the internal codename is **"sand"**. All traffic goes to Cursor's backend (`api2.cursor.sh`, Connect RPC / protobuf). Grok models are served through Cursor's `InferenceService.Stream`. The default model is `grok-4.5`. The app never calls an xAI endpoint directly.
- **How the pieces split.** The desktop app is a thin client. The real agent (the **host**) runs **inside the VM** and exposes an HTTP + SSE gateway. The desktop does three things:
  - renders the UI;
  - proxies requests through a "coordinator" process;
  - runs a detached daemon that lets the in-VM agent run commands on your own Mac.
- **The defining UX trick.** The model's plain text is an *invisible inner monologue*. The **only** way to talk to the user is the `SendMessage` tool. Middleware nags the model when it goes silent, and that is why it "feels like texting a colleague".
- **The agent core.** It is Cursor's own agent engine (`AnysphereAgent`), vendored in and wrapped with a Grok Bot persona and toolset. That toolset includes shell, browser, computer use, MCP, subagents, Cursor cloud agents, routines, memory and approvals.

## Sources

- Code: `grok-bot-0.18-reconstructed-main/source/**`. It is about 441k lines of reconstructed TypeScript. File references in these docs are relative to `source/` unless prefixed with `frontend/`.
- [Introducing Grok Bot (x.ai news)](https://x.ai/news/introducing-grok-bot)
- [Grok Bot 101 guide (x.ai)](https://x.ai/bot/guides/grok-bot-101)
- The `x.ai/bot` landing page itself returned HTTP 403 to automated fetches, so product claims come from the two pages above.

## Caveats

- The repo is an unofficial reconstruction of a compiled app. Names and module boundaries are inferred and may differ from Anysphere's originals. A few production joins are marked "dormant" in the reconstruction; these are called out where relevant.
- Claims are marked **[inferred]** where they were deduced rather than read in code.
- The reconstruction adds an "Inference Router" (Claude Code, Codex, OpenRouter) and a local Docker sandbox. These are **not** part of the shipped product and are flagged wherever they appear.
