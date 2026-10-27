# Evals

Developer-only checks that bots behave as intended with real models (design §8). Each scenario runs the real agent
(router, `BotRuntime`, pi-durable) against a fake world, sends the owner's messages, then checks what happened with
deterministic assertions and an eval judge model's rubric.

```sh
pnpm eval                                   # every scenario on the faux model (no keys needed): checks the pipeline
pnpm eval smoke --model anthropic/claude-sonnet-4-5 --runs 3
pnpm eval groups --model openai/gpt-5 --judge anthropic/claude-sonnet-4-5
pnpm eval voice/short-messages --model anthropic/claude-sonnet-4-5 --runs 10 --report out/voice.md --json out/voice.json
pnpm eval --model anthropic/claude-sonnet-4-5 --record-baseline
```

- **Selection:** `all` (default), `smoke` (scenarios with `smoke: true`, which CI runs), a suite, or `<suite>/<scenario>`.
- **`--model provider/model`** (default `$OPENBOT_EVAL_MODEL`, else `faux`): the bots' model, as pi names it (the
  refs Settings → Models shows). **`--judge`** (default `$OPENBOT_EVAL_JUDGE_MODEL`, else the model) scores rubric
  items. **`--runs`** (default 3), **`--step-timeout`** seconds per owner message (default 300).
- **Keys:** each model's provider is connected with its usual API key variable from your environment, e.g.
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`. Subscriptions
  (OAuth sign-ins) aren't supported here. `pnpm eval` also loads `evals/.env` (git-ignored) if it exists, e.g.
  `OPENCODE_API_KEY=…` for `--model opencode-go/mimo-v2.6-flash`.
- **Faux:** on the faux model every bot plays its scenario's `faux` script and a stand-in judge passes every rubric
  item. That checks the scenario fits the agent, not a model; `pnpm test` runs every scenario this way.
- **Baselines:** `--record-baseline` saves the pass rates to `baselines/<model>.json`; later runs on that model show
  them, with ▼ where a scenario dropped.

## Scenario format

`suites/<suite>/<name>.yaml`:

```yaml
description: What the scenario checks, shown to the judge.
smoke: true                      # part of the smoke suite
bots:
  - name: Ada
    title: Designer              # optional
    instructions: You own the UI. # optional
    model: openai/gpt-5          # optional, real runs only
groups:
  - name: Launch
    members: [Ada, Linus]        # created by the first message to it, then titled with its name
world:
  clock: 2026-03-14T09:00:00Z    # what `date` prints
  shell:                         # first rule whose regex finds the command answers it; others succeed empty
    - match: curl|wget
      stdout: '{"rate": 1.08}'
      exitCode: 0
  pages:                         # the fake browser's pages, by URL (see TestPage in @openbot/core/testing)
    https://shop.test/: { title: Shop, elements: [{ role: heading, name: Shop }] }
  tools:                         # fake tool servers' tools (plugins), each answering `result`
    - { name: ci_status, description: "CI plugin: a branch's build status", result: "main: passing" }
script:                          # the owner's messages to a bot's DM or a group; each waits until all is quiet
  - { to: Launch, text: "@Linus is main green?" }
assert:
  - tool_called: bash                          # or { tool: bash, bot: Ada }
  - tool_not_called: use_computer
  - tool_order: [bash, sendMessage]            # first calls in this order; or { tools: [...], bot: Ada }
  - messages: { in: Launch, from: Ada, min: 1, max: 2 }   # messages bots sent the owner in a chat
  - max_message_length: 400                    # or { chars: 400, in: Ada }
  - no_silent_answer                           # or no_silent_answer: Ada; every owner message got a reply
rubric:
  - Linus says main is green
faux:                            # each bot's model turns on the faux model, in order
  Linus:
    - call: { ci_status: { branch: main } }    # tool calls, several at once allowed
    - send: Yep, main is green                 # a sendMessage call
    - end                                      # ends the run silently; `say: text` ends it with private text
```

A faux script must use every turn it scripts: a turn left over (or a request with none) fails the run, so scripts
stay in step with how the agent works (reply reminders, group rounds).
