# Grok Bot: the life cycle of a prompt

This document traces one prompt end to end, from the moment you press Enter until the Bot's reply bubbles appear (and after).

Paths are relative to `grok-bot-0.18-reconstructed-main/source/`. Renderer paths start with `frontend/`. Where the docs say **[inferred]**, the behaviour was deduced rather than read directly in code.

Running example: you type **"Check my inbox for anything urgent from Acme and summarize it"** to your Bot "Chief of Staff" and attach `notes.pdf`.

---

## Overview

```mermaid
sequenceDiagram
    autonumber
    participant UI as Renderer (React)
    participant CO as Coordinator (desktop utility process)
    participant GW as Host gateway (in cloud VM)
    participant TX as Transcript / SendPipeline
    participant SCH as Run scheduler
    participant RUN as Turn runner (SandAgentRunner)
    participant AG as AnysphereAgent loop
    participant LLM as Cursor InferenceService.Stream (grok-4.5)
    participant TOOLS as Tools (VM exec / MCP / local-exec / subagents)

    UI->>UI: optimistic "pending-<nonce>" bubble
    UI->>CO: MessagePort request sendPrompt{agentId, prompt, richText, attachmentPaths, clientNonce}
    CO->>GW: POST /api/sendPrompt (Bearer token)
    GW->>TX: sendPrompt → idempotency ledger → append user entry t12u (SQLite)
    TX-->>UI: SSE "transcript" appended(t12u) → replaces pending bubble
    TX->>SCH: dispatchUserTurn → interrupt older run → enqueue (lane=user)
    GW-->>CO: 200 {accepted:true}  (returns at acceptance, not at turn end)
    CO-->>UI: reply ok
    SCH->>RUN: runTurn (one active run per agent)
    RUN->>RUN: prepareTurn: model session, MCP discovery, system prompt, tools, ConversationAction
    RUN->>AG: runStream(state, action, mcpTools)
    loop each step (≤ 5000)
        AG->>LLM: Stream(messages, tools)
        LLM-->>AG: text / thinking / tool-call deltas
        AG->>TOOLS: execute each tool call as soon as it completes (parallel)
        TOOLS-->>AG: results (fenced as untrusted, spilled if >40KB)
        AG-->>RUN: updates (SendMessage → transcript entry t12s0, t12s1 …)
        RUN-->>UI: SSE transcript appended(t12sN) + agents{isComposingMessage, currentActivity}
    end
    RUN->>RUN: settle: reply nudges if silent, memory extraction, labeling, persist
    RUN-->>UI: SSE agents{isRunning:false}; OS notification / mobile push
```

---

## Phase 1: Renderer: compose and submit

### 1.1 Composing
- **Composer.** `ConversationComposer` (`frontend/src/recovered/features/conversation/workspace/composer.tsx`) uses a **TipTap** rich-text editor (`rich-text-editor.tsx`).
- **Serialization.** `serializePromptNode` turns the editor document into plain text. Mentions become `@label` and links become `text (href)`. The raw TipTap JSON is kept as `richText`.
- **Attachments.** Dropped or pasted files are *staged* (`stageFiles`) and are not uploaded yet.
- **Draft.** The draft is `{prompt, richText, attachments[{path,name,mimeType}], isFork?}` and is persisted per chat.

### 1.2 Submit (`frontend/src/production/ProductionRenderer.tsx:2937`, `submit()`)
1. Read the draft and apply the reply-to thread, if you are replying to a specific message.
2. Mint a **`clientNonce`**. This is the idempotency key that follows the prompt all the way to the VM.
3. Build a `ComposerSubmission{nonce, agentId, prompt, richText, attachments, createdAtMs, replyToId?, isFork?}`.
4. **Optimistic UI.** Insert a row `{id:"pending-<nonce>", role:"user", delivery:"pending"}`, so your bubble appears instantly.
5. Hand the submission to `composerSubmissionQueue.submit()`.

### 1.3 Renderer send queue (`frontend/.../submission.ts:55`)
- **One in-flight send per agent.** If you fire three messages quickly, the 2nd and 3rd go to `"queued"`.
- **Offline.** When the transport is down, sends are queued and flushed on reconnect.
- **Phases.** `pending → sent | failed | queued | cancelled`.
- **Cancelling.** Only a *queued* send can be cancelled. **There is no "stop generating" button by design**: the way to redirect a Bot is to send another message (see Phase 3.4).
- **Failure.** On failure the draft is restored. After any accepted send, one-shot local-tool approvals are cleared.

### 1.4 The wire payload (`sendComposerPrompt`, `ProductionRenderer.tsx:989`)
First the staged files are committed, which gives them stable paths. Then the renderer calls:

```ts
client.call("sendPrompt", {
  agentId, prompt, richText,
  attachmentPaths: ["/…/notes.pdf"], attachmentNames: ["notes.pdf"],
  clientNonce, enterEpochMs, composedAtMs,
  replyToId?, isFork?, directAddressedAcceptance: true,
})
```

There is **no "selected context" object**. Mentions travel inside the text, and files travel as *paths* that the host loads itself.

---

## Phase 2: Desktop transport: renderer → coordinator → VM

### 2.1 The MessagePort (set up once at app start)
1. Preload's `createCoordinatorPortBroker` asks main for the port with `sand:coordinator-port-request`.
2. Main checks that the request comes from the trusted main frame, then `launchCoordinator` forks the coordinator as a `utilityProcess` with 3 channels: control, renderer-data and main-data.
3. The renderer-data port is transferred to the renderer as `window.coordinatorPort`.

### 2.2 Request frame (`frontend/src/production/coordinator-client.ts:157`)
- The handshake is `hello` followed by `ready`.
- `call()` posts `{kind:"request", requestId:"r-42", method:"sendPrompt", args}` and waits for `{kind:"reply", requestId, outcome}`.
- On the coordinator side, `renderer-port-server.ts` keeps an `AbortController` per request.

### 2.3 Coordinator dispatch (`node-agent-coordinator/main.ts:223`)
1. `recorder.beginSend({clientNonce})` starts **send→echo latency** telemetry.
2. *(Reconstruction-only)* `inferenceRouter.dispatch()`. If the provider is Claude Code, Codex or OpenRouter, the coordinator runs the turn itself and the request never reaches the VM.
3. Default path: `CoordinatorGatewayClient.sendPrompt` (`gateway/gateway-client.ts:348`) sends:
   ```
   POST https://<pod>-1340.<anyrun-domain>/api/sendPrompt
   Authorization: Bearer <gatewayToken>
   x-anyrun-network-token: <networkToken>
   traceparent: …
   body: the args above
   ```
4. **Retry rule.** It retries once, to the same base URL, and *only* if one of these is true:
   - the POST never left the machine, or
   - this host has already proven it de-duplicates by nonce.

   A 4xx is never retried. The aim is never to send the same prompt twice.

The gateway URL itself comes from main's VM connector (`GrokBotService.EnsureSandBox`), which is cached and health-checked by `SandHostSupervisor`.

---

## Phase 3: Host: accept, persist, enqueue

### 3.1 Gateway (`host/gateway-server.ts`, `host-gateway-api.ts:184`)
1. Reject browser origins, check the bearer token, and route `/api/sendPrompt` to `api.sendPrompt(args)`.
2. Resolve `agentId` (from the args, otherwise the active agent).
3. Call `manager.sendPrompt(..., {awaitTurn:false})`.
4. **Return `{accepted:true}` as soon as the prompt is durably accepted, not when the turn ends.** The HTTP call is short. Everything after this point streams over SSE.

### 3.2 Idempotency (`host/extensions/transcript/send-pipeline.ts:100`)
- If the same nonce is already in flight, the call **coalesces** onto that attempt.
- Otherwise a digest of `{agentId, prompt, richText, replyToId, isFork, attachments}` is computed and `acceptanceLedger.admitSend({clientNonce, inputDigest})` is called. An already-accepted nonce is a no-op, and a nonce with a different digest is an error.

### 3.3 Durable append and echo (`sendPromptOnce`, `send-pipeline.ts:149`)
1. Check that a runner is bound (`turn-execution`).
2. **Roster side effects** (`applySendRosterSideEffects`):
   - a default-named Bot is auto-named from the first 72 characters of the prompt;
   - error trays are cleared;
   - `awaitingUserResponse` is cleared.
3. Build the attachment entry `t12ua0 {fileName:"notes.pdf", byteSize, clientNonce}`.
4. Build the user entry:
   ```json
   {"kind":"message","id":"t12u","role":"user","content":"Check my inbox…","richText":"…","clientNonce":"…"}
   ```
   It is **persisted to SQLite before it is emitted** (`persistBeforeEmit`). A failed write throws `SandSendNotPersistedError`.
5. Record the acceptance plus an **ack obligation**: this message is owed a reply.
6. **Emit the echo** `{type:"appended", entry}` on the transcript stream. The renderer matches the `clientNonce` and swaps `pending-<nonce>` for the real `t12u`. The coordinator closes its send→echo latency span.
7. Split the attachments into images (bytes loaded now), videos and files.
8. A group or shared room goes to `dispatchMirrorOrGroupSend`. A normal 1:1 chat goes to **`dispatchUserTurn`**.

### 3.4 Dispatch, steering and supersede (`send-turn-dispatch.ts:49`)
1. **Expand the prompt.** Workflow chips become skill references, `@mentioned` Bots get context, and an offline-composed note is added when relevant.
   - [inferred] The renderer always sends `composedAtMs`, so as reconstructed a `[Composed offline at …]` prefix appears on every send. This is probably a reconstruction artifact.
2. **Bump the turn epoch** for this conversation. Every downstream result is fenced by its epoch.
3. **Supersede.** If the Bot is already running a turn, `runner.interrupt("superseded by a new user message")`. The old run's unanswered user messages are carried into the next run as `prependUserMessages`. **This is how you "steer" a running Bot: send it another message.**
4. **Enqueue.** `runLifecycle.enqueueExclusiveRun(agentId, () => turnRuntime.runTurn(...), {lane:"user"})`.

### 3.5 The run scheduler (`host/extensions/transcript/run-scheduler.ts`)
- **Exactly one active run per agent.** There are three queues, `user > agent > background`. A routine fire or a peer Bot's message waits behind your message.
- **Watchdog.** If your message has waited more than **120 s** behind a wedged run, that run is interrupted. After **30 s** more it is detached as a zombie and the queue moves on.
- **Stale turns.** If a queued turn's epoch is stale and its text can be folded into the newer turn, it is **skipped** (`turn-runtime.ts:366`). Several rapid messages therefore collapse into one turn.
- `beginSessionRun` sets `isRunning`, which makes the sidebar show the Bot as working.

---

## Phase 4: Preparing the turn

### 4.1 `TurnRuntime.runTurn` → `SandAgentRunner.run` → `createTurnRunShell.run` (`host/runner/turn-run-shell.ts:534`)
1. Start a new Auto-review user-message epoch, which expires approval cards from the previous turn.
2. Create a `requestId` and an `AbortController`, and emit `run started`.
3. Set up `createTurnSettle` collectors: text, number of SendMessages, reactions.
4. Run the conversation-size guard, start a local-tool permission turn, and resolve the privacy mode.
5. **Create the inference session** (`host/extensions/inference/cursor-session.ts`). The model is `grok-4.5` with maxMode, effort high and fast. Overrides come from experiments or env. A summarization session is created too.
6. **Discover MCP tools** for this turn. A failure is noted but does not stop the turn. Per-connector custom instructions are also resolved.

### 4.2 `prepareTurn` (`production-turn-run-shell-adapter.ts:232`)
- **Executor middleware chain.** `DiskPressureReminder`, then `SendMessageReminder`, then `StartOfTurnAckReminder`, then the executor. These can inject hidden `<system_reminder>`s before every model call.
- **`buildAgentForRun`** (`turn-agent-composition.ts:744`):
  - **Toolset**: `buildTurnTools` gives SendMessage, Shell/Read (VM), External* (your Mac), MCP meta-tools, Task, CloudAgent, update_state and the rest. See [03-agent-brain.md §2](03-agent-brain.md#2-tools).
  - **System prompt**: `createSystemPromptAssembly().getSystemPrompt()`. It contains the base persona, the spotlight fence note, the agent profile, user identity, time zone, **memory**, routines, workflows, the agent directory, MCP instructions and the "your box / desktop" sections.
  - A new **`AnysphereAgent`** with `maxSteps 5000`.
- **Resource accessors** decide where each tool executes:
  - the remote VM accessor (exec daemon :1337);
  - your Mac's accessor (local-exec, audited as `user_machine`);
  - MCP, guarded by Auto-review;
  - the subagent executor.

### 4.3 Building the user message (`assembleGeneratedTurnAction`, `prompt-collector-glue.ts:371`)
1. `notes.pdf` is **uploaded into the VM** when the VM is available.
2. The text becomes:
   ```
   [t12u]
   Check my inbox for anything urgent from Acme and summarize it

   The user attached these files… notes.pdf (84 KB) — read with ExternalRead, also copied into your box at /workspace/…/notes.pdf
   <reply reminder appended>
   ```
3. `selectedContext` gets any image bytes and videos.
4. `prependUserMessages` holds earlier messages that never got a confirmed turn (the steering carry-over), plus any "Unanswered questions:" from open widgets.
5. Result:
   ```
   ConversationAction{ userMessageAction{ userMessage{text, messageId, richText, selectedContext}, prependUserMessages } }
   ```
6. Inside the agent core, this becomes the final user turn:
   ```
   <system_reminder>…</system_reminder>
   <timestamp>Sunday, Oct 25, 2026, 3:04 PM (UTC+2)</timestamp>
   <user_query>…</user_query>
   ```
   It follows the system prompt, the `<user_info>` preamble and the prior history. See [03-agent-brain.md §1](03-agent-brain.md#1-what-the-model-sees).

### 4.4 Start the stream
`ensureBoxReady()` runs, then `AnysphereAgent.runStream(ctx, state, action, mcpTools, persistCheckpoint)` (`packages/agent/index.ts:84`). This restores the conversation state from the content-addressed blob store and hands control to `UserMessageActionHandler`.

---

## Phase 5: The model loop

### 5.1 One step = one model call (`abstract-user-message-action-handler.ts:2548`, `runTurnLoop`)

```
step 0 → runWithSummarizationRetry → runWithMaxTokensRetry → runStep → executeToolStream
```

### 5.2 The network call (`packages/chat-inference-proto/client.ts:145`)
- **Request.** `buildStreamRequest({messages, requestedModel:"grok-4.5", tools, modelConfig, conversationId, …})` is sent as Connect server-streaming **`aiserver.v1.InferenceService.Stream`** to `api2.cursor.sh`, with `x-request-id` and `traceparent` headers.
- **Middlewares.** Image resizing, effort level, tracing, continuation injection and trailing-empty-assistant removal.
- **Response mapping.** Each response part becomes a stream event:

  | Response part | Becomes |
  |---|---|
  | `textPart` | `text-delta` |
  | `thinkingPart` | `reasoning` |
  | `toolCallPart` | `tool-call-streaming-start` / `tool-call-delta` / `tool-call` |
  | `usage` / `extendedUsage` | resolve the usage promises |
  | `error` | thrown |

### 5.3 What the model does in our example (typical shape)

| Step | Model output | Execution |
|---|---|---|
| 0 | `SendMessage{type:"text", content:"On it, checking your inbox for Acme now."}` and, in the same step, `GetMcpTools{server:"gmail"}` | Both tool calls start **as soon as their arguments finish streaming**, in parallel. The SendMessage appears in your chat within about a second. |
| 1 | `CallMcpTool{server:"gmail", toolName:"search", arguments:{q:"from:acme.com newer_than:3d"}}` | Auto-review gate, then the MCP executor. The result is fenced in `<cursor_untrusted_data_1337 source="Tool">`. |
| 2 | `ExternalRead{path:"…/notes.pdf"}` or `Read` on the VM copy | The VM exec daemon (or local-exec, permission-gated) |
| 3 | `SendMessage` ×2: the summary bubbles | Host-local, turned into transcript entries |
| 4 | No tool call | The loop ends |

If the model had made more than 6 tool calls without a SendMessage, a `<system_reminder>` ("the user is currently watching silence…") would have been injected before the next call.

### 5.4 Tool execution and routing (`packages/agent/tool-stream-executor.ts:1279`)
- Tool calls stream in and each one starts executing immediately (`executeDeferredToolCall`). All of them are awaited together at the end of the step. The step returns `[assistant message, ...tool results]`, and the loop runs again if there was any tool call.
- **Routing:**

| Tool | Executed by |
|---|---|
| `SendMessage` | **Host-local.** Becomes `transport.onUpdate({type:"send-message"})`, then a transcript entry. Returns `{messageId:"t12s0"}`. |
| `Shell` / `Read` / computer / browser | VM exec daemon on `127.0.0.1:1337` (Connect `ExecService`), audited as `box` |
| `ExternalShell` / `ExternalRead` | Local-exec. The host queues the request on SSE `/local-exec/requests`, the desktop daemon runs it, and the result returns through `POST /local-exec/responses`. Each call passes the **permission dock** (Allow once / Always / Deny). |
| MCP | MCP executor wrapped by `createTurnMcpExecutorGuard`. An auth failure becomes a "Connect" card. |
| `Task` | Subagent runner, which returns `{status:"background"}` immediately. Its completion later revives this Bot. |
| `WebSearch` / `WebFetch` / `GenerateImage` | Cursor backend `AiService` |

- **Gates before every side effect:**
  - **Auto-review.** The classifier allows or blocks the action. While any approval card is pending, `assertNoPendingApproval()` refuses all new side effects.
  - **Hooks.** `beforeShellExecution`, `preToolUse` and similar hooks run here.
- **After execution:**
  - output over 40 KB is spilled to `.sand/tools/*.txt`;
  - results are fenced as untrusted;
  - per-tool timeouts are tiered from 5 to 120 minutes.

### 5.5 Retries and compaction
- **`runWithMaxTokensRetry`** handles an output-limit hit, an empty response, or a detected repetition loop.
- **`runWithSummarizationRetry`**, up to 5 attempts: on an input-token-limit or too-many-images error, it runs **blocking summarization** and then retries the step. Background summarization starts at 10% context left and persists at 5%.
- **Outer stream retry.** First-token stall at 150 s, overload backoff and resume-from-checkpoint exist in `stream-attempt.ts`, but they are marked **dormant** in this reconstruction. The active path calls `startStream` directly.

### 5.6 What interrupts a turn
There is no stop button. A turn is interrupted by:
1. a new user message (supersede);
2. the scheduler watchdog;
3. **waiting on you**: a widget, a secret request, an auto-review approval or `request_box_help`. This is an *intentional* cancel, so it does not count as an abort;
4. a host upgrade quiesce.

The abort propagates through `AbortController`, then the agent `ctx.signal`, then the Connect stream and the running tools.

---

## Phase 6: Streaming results back to you

### 6.1 Host side (`host/extensions/transcript/turn-runtime.ts:625`, `handleAgentUpdate`)
Agent updates are mapped by `ForwardingInteractionListener` (`host/runner/agent-adapters.ts`) to `RunnerUpdate`s, then handled here:

| Update | Effect |
|---|---|
| `text-delta`, `thinking-delta` | **Not shown as text.** They only drive activity state (`currentActivity: thinking`). |
| pending `SendMessage` tool call | `isComposingMessage = true`, which makes the typing indicator appear |
| other tool call | `currentActivity: {kind:"tool", name}`, held for 2.5 s; also telemetry |
| **`send-message`** | New entry `t12s0` (`{kind:"send-message", id, message:{type, content…}, timestampMs}`). Persisted to SQLite, emitted as `{type:"appended"}`, fulfils the **ack obligation**, and returns the `messageId` to the model. Channel messages (for example Slack) are also delivered externally. |
| `client-side-tool-v2` | Typed tool-card stream for the UI |
| `react-to-message` | Reaction applied to your message |
| `auto-review-status` / `local-tool-permission-status` | Card status updated in place |
| `turn-ended` | Usage reported |

### 6.2 Fan-out
1. `RosterProjection.emit` stamps each event with `ordered:{replicaKey:"transcript:<agentId>", epoch, sequence}`.
2. `SandHost.wireEvents` publishes it on SSE `/events` channels: `transcript`, `agents`, `client-side-tool-v2`, `outline`, `subagents`, `async-tasks`, and others.
3. The coordinator (`main.ts:102`, `handleGatewaySseEvent`) reposts each one as a renderer port event. `agents` is also mirrored to Electron main for notifications.

### 6.3 Renderer
- `createTranscriptFeedFanout` routes `snapshot`, `appended`, `updated` and `cleared` events.
- `onAppended`: if the entry carries your `clientNonce`, it replaces the pending bubble. Otherwise it appends, so a `send-message` from the Bot becomes a new bubble or card.
- The `agents` events drive the sidebar spinner, the "typing…" indicator and preview text.
- The `{epoch, sequence}` stamps let the UI drop duplicates and detect a host restart.

---

## Phase 7: Settling the turn

### 7.1 Reply guarantee (`turn-runtime.ts:534`, `ensureUserReply`)
- If the run ended with **zero SendMessages and no reaction**, the host re-runs a hidden `REPLY_NUDGE_PROMPT`, at most `MAX_REPLY_NUDGES = 3` times, while the epoch is still current.
- If the turn acked and then ended on silent tool calls, it runs `CLOSING_SEND_NUDGE_PROMPT` once.
- You are never left on "read".

### 7.2 Persistence (`host/runner/turn-settle.ts`)
- **Each checkpoint:**
  1. prepare the transcript mirror;
  2. write the agent store (the blob DAG root);
  3. commit the mirror.

  A mirror commit failure after the checkpoint is fatal and is never retried.
- **Final state.** Persisted only if this run generation still owns the conversation.

### 7.3 Post-turn work
- **Labeling.** A backend RPC classifies the turn.
- **Memory.** `runTurnMemory` makes a side LLM call that extracts profile, log and note facts. Every 6 turns it also writes an episode journal sentence.
- **Finalize.** `turn.finalize("success" | "cancelled" | "error")`. An error shows a tray ("Agent failed to respond" or provider-overload) if the epoch is still current.
- **End the run.** `endSessionRun` sets `isRunning=false`, emits the roster, and schedules any pending ack re-drive. Then `automationRuntime.emitAutomations` runs.

### 7.4 Notifications
- **Desktop.** Main's `SandOsNotificationManager` diffs roster snapshots. A new last message (or "<Bot> needs you" when it is waiting on input) raises an Electron notification, but only while the window is unfocused, throttled to one per 5 s, and not for hidden Bots.
- **Mobile.** The host `notifications` extension pushes "turn finished" through `GrokBotService` if you haven't been on the desktop in the last 5 minutes.
- **Durability.** About 5 s later, `box-store-sync` captures `store.db` to S3.

---

## Phase 8: What happens *after* (asynchronous continuations)

The turn can end while work is still running:

| Trigger | What happens |
|---|---|
| Background shell finishes (`block_until_ms:0`) | `RevivingBackgroundWorkRegistry` sees the terminal file complete, then enqueues a **revival turn** (lane `background`) with a hidden prompt. The Bot posts results without you asking. |
| Subagent finishes | `backgroundTaskCompletionAction` revives the parent Bot. |
| You answer a widget, approval or secret card | `respondToWidget`, `resolveAutoReviewApproval` or `submitSecret` resumes the Bot in a new turn. |
| You hand back the computer after `request_box_help` | A box-handoff resume turn starts, and the Bot takes a `Screenshot` and continues. |
| Routine fires | The backend notifies the host, which runs a hidden `[routine]` turn with `isSilenceAllowed`. |
| Another Bot messages it | `SendToAgent` enqueues in the `agent` lane. |

---

## Concurrency rules cheat sheet

| Layer | Rule |
|---|---|
| Renderer | One in-flight send per agent. The rest are queued, offline sends are queued, and only queued sends can be cancelled. |
| Coordinator | At most one retry of `sendPrompt`, and only when it is provably safe. |
| Host accept | Idempotent by `clientNonce` plus an input digest. |
| Host dispatch | A new user message **interrupts** the active run and carries unanswered text forward. |
| Scheduler | One active run per agent, lanes user > agent > background, watchdog 120 s + 30 s. |
| Stale turns | Skipped when they can be folded into a newer turn. |
| Agent loop | Steps run sequentially. Tool calls within a step run in parallel and start while still streaming. |
| Side effects | None while an Auto-review approval is pending. |

---

## Mapping to openbot

A minimal openbot equivalent of this pipeline:

1. **Client.** Optimistic bubble plus a nonce. A per-bot send queue. No stop button needed if new messages supersede.
2. **API.** `POST /bots/:id/messages` validates the nonce, appends the message, enqueues the run, and returns `202 {accepted}` straight away.
3. **Events.** SSE or WebSocket `/events` with `{epoch, seq}` stamps. The client reconciles by nonce.
4. **Worker.** One run per bot. Lanes for user, agent and background. A supersede-and-carry-forward rule.
5. **Turn.** Build the system prompt (persona + memory + tools), then loop: `stream model → run tools in parallel → repeat`, with `SendMessage` as the only user-visible output and reminder middleware.
6. **Settle.** Send a reply nudge if the run was silent, extract memory, persist a checkpoint, and notify.
