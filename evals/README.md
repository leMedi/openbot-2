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
  - name: Linus
    scripted: true               # plays its faux turns on every model, then passes: lines a test needs said
groups:
  - name: Launch
    members: [Ada, Linus]        # created by the first message to it, then titled with its name
world:
  clock: 2026-03-14T09:00:00Z    # where the server's clock starts, standing still but for `advance`; `date` prints it
  shell:                         # first rule whose regex finds the command answers it; others succeed empty
    - match: curl|wget
      stdout: '{"rate": 1.08}'
      exitCode: 0
  pages:                         # the fake browser's pages, by URL (see TestPage in @openbot/core/testing)
    https://shop.test/: { title: Shop, elements: [{ role: heading, name: Shop }] }
  tools:                         # tools every bot has (surface mcp), each answering `result`
    - { name: ci_status, description: "CI plugin: a branch's build status", result: "main: passing" }
  plugins:                       # the plugin catalog, by name, each served by a fake hosted MCP server; without it
    notion:                      # the catalog is empty (never the bundled plugins)
      display_name: Notion       # optional, the name by default
      description: Your Notion workspace
      keywords: [docs, wiki]     # optional, what else search_plugins finds it by
      tools:                     # bots granted an account call them as mcp__notion_account1__search…
        - { name: search, description: Search pages, result: "Q3 roadmap" }
        - name: fetch
          description: Read a page
          result: { Personal: Groceries, Work: Q3 roadmap }   # or by the account called
      accounts:                  # connected before the run, account1, account2… in order, named so
        - { name: Personal, granted: [Linus] }              # and granted to these bots
        - Work
extraction: true                 # extracts memory after every run, on the bots' model (faux: `faux_memory`)
memory:                          # facts the owner added before the run; without `bot`, to shared memory
  - { bot: Ada, tier: profile, text: The owner ships on Fridays., importance: 3 }   # tier and importance optional
routines:                        # routines the owner set up before the run
  - { bot: Linus, name: Build watch, prompt: Tell me about failing builds., schedule: "0 9 * * *" }
script:                          # every step but `forget` waits until all is quiet, memory extraction included
  - { to: Launch, text: "@Linus is main green?" }   # the owner's message to a bot's DM or a group
  - compact: Linus                                  # compacts the bot's history, as near its context window, with a
                                                    # summary that says nothing: past it, the bot knows only its memory
                                                    # and the newest entries (kept verbatim)
  - forget: fridays                                 # the owner deletes every fact this regex matches (any case)
  - advance: 2h                                     # the clock moves forward (m, h or d), or to a time
  - advance: 2026-03-15T09:00:00Z                   # (`advance: <timestamp>`), stopping at each routine fire on the
                                                    # way until the bots are done with it
  - { decide: Linus, plugin: notion, grant: Work }  # the owner grants an account on the bot's newest undecided
  - { decide: Linus, plugin: notion, deny: true }   # request for the plugin, or denies it; nothing without one
assert:
  - tool_called: bash                          # or { tool: bash, bot: Ada }
  - tool_not_called: use_computer
  - tool_order: [bash, sendMessage]            # first calls in this order; or { tools: [...], bot: Ada }
  - messages: { in: Launch, from: Ada, min: 1, max: 2 }   # messages bots sent the owner in a chat
  - messages: { in: Launch, matches: green, min: 1 }      # only those a regex matches (any case)
  - messages: { in: Ada, last: true, max: 0 }             # only those after the owner's last message in the chat
  - memory: { in: shared, matches: fridays, max: 0 }      # facts at the end a regex matches: in shared, a bot's, or anywhere
  - routines: { bot: Linus, by: bot, schedule: "^0 8 ", prompt: digest, min: 1 }  # routines at the end: a bot's or any,
                                                    # by the owner or a bot (who last wrote it), regexes on name, prompt, schedule
  - routines: { name: build watch, ran: true, messaged: false, min: 1 }  # only those with (or without) a run that ran,
                                                    # or that messaged the owner
  - max_message_length: 400                    # or { chars: 400, in: Ada }
  - no_silent_answer                           # or no_silent_answer: Ada; every owner message got a reply
  - granted_tools_only                         # every mcp__… call reached its plugin's server: none ungranted
rubric:
  - Linus says main is green
faux:                            # each bot's model turns on the faux model, in order
  Linus:
    - call: { ci_status: { branch: main } }    # tool calls, several at once allowed
    - send: Yep, main is green                 # a sendMessage call
    - end                                      # ends the run silently; `say: text` ends it with private text
faux_memory:                     # the memory model's answers, one per extraction, in order (needs `extraction`)
  - NONE
  - "new shared profile 4: The owner ships on Fridays."
```

A faux script must use every turn it scripts: a turn left over (or a request with none) fails the run, so scripts
stay in step with how the agent works (reply reminders, group rounds). The same goes for `faux_memory`: an extraction
it has no answer for, or an answer left over, fails the run. Compaction summaries come from the runner, on every model.

A plugin request card is one of the bot's messages to the owner ("Wants to use Notion: …"). The run's record lists
the plugin tool calls the plugins' servers answered (`pluginCalls`), with the account's name.

A bot's change to a routine posts a timeline row in its DM; it isn't a message to the owner, so message checks skip it.
The judge sees it marked as such, and the routines at the end with their runs.

On real models the bots' model is also the memory model, and a skipped extraction (the model failed twice) fails
the run. The judge sees the facts in memory at the end beside the chats and tool calls.
