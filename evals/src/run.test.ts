import { answeringProvider } from '@openbot/agent/testing'
import { describe, expect, it } from 'vitest'
import { runScenario } from './run.ts'
import { parseScenario } from './scenario.ts'

const scenario = (yaml: string) => parseScenario(yaml, { suite: 'test', name: 'scenario' })

describe('running a scenario on the faux model', () => {
  it('runs the real agent in the fake world and checks what happened, with the faux judge', async () => {
    const result = await runScenario(
      scenario(`
bots: [{ name: Ada }, { name: Linus }]
groups: [{ name: Launch, members: [Ada, Linus] }]
world:
  clock: 2026-03-14T09:00:00Z
  shell: [{ match: wttr, stdout: "Paris: sunny" }]
  tools: [{ name: release_status, description: Status of the release, result: Green }]
script:
  - { to: Ada, text: "Weather in Paris? And the time?" }
  - { to: Launch, text: "Morning! Release status?" }
assert:
  - tool_order: { tools: [bash, sendMessage], bot: Ada }
  - tool_called: { tool: release_status, bot: Linus }
  - tool_not_called: use_computer
  - messages: { in: Ada, min: 2, max: 2 }
  - messages: { in: Launch, from: Ada, max: 0 }
  - no_silent_answer
rubric: [Sounds casual]
faux:
  Ada:
    - call: { bash: { command: curl wttr.in/Paris }, read: { path: /nowhere } }
    - call: { bash: { command: date } }
    - send: Sunny in Paris
    - send: "It's 9:00"
    - end
    # Her turns in the group: she passes in round 1, and again in round 2 after Linus posted.
    - end
    - end
  Linus:
    - call: { release_status: {} }
    - send: Release is green
    - end
`),
      { kind: 'faux' },
    )

    expect(result.error).toBeUndefined()
    expect(result.assertions.filter((assertion) => !assertion.passed)).toEqual([])
    expect(result.rubric).toEqual([{ item: 'Sounds casual', passed: true, reason: 'The faux judge passes every item' }])
    expect(result.record.chats).toEqual({
      Ada: [
        { from: 'owner', author: 'You', text: 'Weather in Paris? And the time?' },
        { from: 'bot', author: 'Ada', text: 'Sunny in Paris' },
        { from: 'bot', author: 'Ada', text: "It's 9:00" },
      ],
      Linus: [],
      Launch: [
        { from: 'owner', author: 'You', text: 'Morning! Release status?' },
        { from: 'bot', author: 'Linus', text: 'Release is green' },
      ],
    })
    expect(result.record.toolCalls.filter((call) => call.bot === 'Ada').map((call) => call.tool)).toEqual([
      'bash',
      'read',
      'bash',
      'sendMessage',
      'sendMessage',
    ])
    expect(result.world.shell).toEqual([
      { bot: 'Ada', command: 'curl wttr.in/Paris', stdout: 'Paris: sunny' },
      { bot: 'Ada', command: 'date', stdout: 'Sat, 14 Mar 2026 09:00:00 GMT\n' },
    ])
  })

  it('reports failed checks, and a faux script that does not fit the run as an error', async () => {
    const result = await runScenario(
      scenario(`
bots: [{ name: Ada }]
script: [{ to: Ada, text: hi }]
assert: [no_silent_answer]
faux:
  Ada: [end, end, end, end, end]
`),
      { kind: 'faux' },
    )

    // The reply guarantee reminds a silent bot three times.
    expect(result.assertions).toEqual([{ label: 'no_silent_answer', passed: false, detail: 'unanswered: "hi"' }])
    expect(result.error).toBe('The faux script has 1 turn left over: it no longer fits the scenario')
  })
})

describe('running a memory scenario on the faux model', () => {
  it("seeds the owner's facts, extracts on the faux memory model, compacts, forgets, and records memory at the end", async () => {
    const result = await runScenario(
      scenario(`
extraction: true
bots: [{ name: Ada }]
memory:
  - { bot: Ada, text: "The owner's dog is called Biscuit." }
  - { text: The owner drinks tea., tier: log, importance: 2 }
script:
  - { to: Ada, text: "I moved to Porto last week." }
  - compact: Ada
  - forget: biscuit
  - { to: Ada, text: "What's my dog called?" }
assert:
  - memory: { in: shared, matches: porto, min: 1 }
  - memory: { matches: biscuit, max: 0 }
  - messages: { in: Ada, matches: biscuit, max: 0 }
faux:
  Ada:
    - send: Porto, nice! Noted
    - end
    - send: You haven't told me yet
    - end
faux_memory:
  - "new shared profile 4: The owner lives in Porto."
  - NONE
`),
      { kind: 'faux' },
    )

    expect(result.error).toBeUndefined()
    expect(result.assertions.filter((assertion) => !assertion.passed)).toEqual([])
    expect(result.record.memory).toEqual([
      { in: 'shared', tier: 'log', text: 'The owner drinks tea.', source: 'owner' },
      { in: 'shared', tier: 'profile', text: 'The owner lives in Porto.', source: 'Ada' },
    ])
  })

  it('fails a run whose extraction the faux memory model could not answer, or left an answer over', async () => {
    const run = (fauxMemory: string) =>
      runScenario(
        scenario(`
extraction: true
bots: [{ name: Ada }]
script: [{ to: Ada, text: "I moved to Porto last week." }]
faux:
  Ada: [{ send: Noted }, end]
${fauxMemory}`),
        { kind: 'faux' },
      )

    expect((await run('')).error).toMatch(/Ada's memory extraction was skipped/)
    expect((await run('faux_memory: [NONE, NONE]')).error).toBe("The faux memory model has 1 answer left over: it no longer fits the scenario")
  })
})

describe('running a routines scenario on the faux model', () => {
  it("starts the clock at the world's, sets up the owner's routines, fires them as the clock moves, and records routines at the end", async () => {
    const result = await runScenario(
      scenario(`
bots: [{ name: Ada }]
world: { clock: 2026-03-16T08:30:00Z }
routines:
  - { bot: Ada, name: Build watch, prompt: Tell me about failing builds., schedule: "0 9 * * *" }
script:
  - { to: Ada, text: Remind me at 10 to call the dentist }
  - advance: 1h
  - advance: 2026-03-16T10:00:00Z
assert:
  - routines: { bot: Ada, by: bot, schedule: "^at 2026-03-16T10:00$", min: 1, max: 1 }
  - no_silent_answer
faux:
  Ada:
    - call: { bash: { command: date } }
    - call: { update_state: { target: routine, action: create, name: Dentist, prompt: Remind the owner to call the dentist., schedule: "at 2026-03-16T10:00" } }
    - send: Will do
    - end
    # The build watch at 09:00: nothing to report.
    - call: { bash: { command: date } }
    - end
    # The reminder at 10:00.
    - send: Time to call the dentist
    - end
`),
      { kind: 'faux' },
    )

    expect(result.error).toBeUndefined()
    expect(result.assertions.filter((assertion) => !assertion.passed)).toEqual([])
    expect(result.world.shell.map((command) => command.stdout)).toEqual(['Mon, 16 Mar 2026 08:30:00 GMT\n', 'Mon, 16 Mar 2026 09:00:00 GMT\n'])
    expect(result.record.routines).toEqual([
      { bot: 'Ada', name: 'Build watch', prompt: 'Tell me about failing builds.', schedule: '0 9 * * *', enabled: true, by: 'owner', runs: [{ status: 'ran', messaged: false }] },
      { bot: 'Ada', name: 'Dentist', prompt: 'Remind the owner to call the dentist.', schedule: 'at 2026-03-16T10:00', enabled: false, by: 'bot', runs: [{ status: 'ran', messaged: true }] },
    ])
    // The routine's timeline row is no message to the owner.
    expect(result.record.chats.Ada).toEqual([
      { from: 'owner', author: 'You', text: 'Remind me at 10 to call the dentist' },
      { from: 'timeline', author: 'Ada', text: 'Ada created routine *Dentist*' },
      { from: 'bot', author: 'Ada', text: 'Will do' },
      { from: 'bot', author: 'Ada', text: 'Time to call the dentist' },
    ])
  })
})

describe('running a scenario on real models', () => {
  it('connects their providers from the environment and judges with the judge model', async () => {
    // Stands in for a real provider: the bot only ever thinks aloud, and the judge fails the item.
    const stub = answeringProvider('stub', (prompt) =>
      prompt.includes('\nRubric:') ? '{"verdicts": [{"item": 1, "pass": false, "reason": "Said nothing"}]}' : 'Thinking about it…',
    )
    const run = (env: Record<string, string>) =>
      runScenario(
        // Linus, on a model of his own, needs the fake provider connected too.
        scenario('bots: [{ name: Ada }, { name: Linus, model: fake/fake-mini }]\nscript: [{ to: Ada, text: hi }]\nassert: [no_silent_answer]\nrubric: [Answers]'),
        {
        kind: 'real',
        model: 'stub/model',
        judge: 'stub/model',
        env,
        providers: [stub],
        },
      )

    expect((await run({})).error).toMatch(/No API key for fake/)

    const result = await run({ FAKE_API_KEY: 'sk-env' })
    expect(result.error).toBeUndefined()
    expect(result.assertions).toMatchObject([{ passed: false }])
    expect(result.rubric).toEqual([{ item: 'Answers', passed: false, reason: 'Said nothing' }])
  })

  it('has a scripted bot play its faux turns, then pass, while the others answer on the model', async () => {
    const stub = answeringProvider('stub', (prompt) => (prompt.includes('\nRubric:') ? '{"verdicts": []}' : 'Thinking about it…'))
    const result = await runScenario(
      scenario(`
bots: [{ name: Linus, scripted: true }, { name: Ada }]
groups: [{ name: Lunch, members: [Linus, Ada] }]
script: [{ to: Lunch, text: Where should we eat on Friday? }]
assert:
  - messages: { in: Lunch, from: Linus, matches: vegan, min: 1 }
faux:
  Linus: [{ send: "The owner is vegan, so the green place" }, end]
`),
      { kind: 'real', model: 'stub/model', judge: 'stub/model', env: {}, providers: [stub] },
    )

    expect(result.error).toBeUndefined()
    expect(result.assertions).toMatchObject([{ passed: true }])
  })
})
