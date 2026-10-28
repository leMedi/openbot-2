import { describe, expect, it } from 'vitest'
import { parseScenario } from './scenario.ts'

const parse = (yaml: string) => parseScenario(yaml, { suite: 'voice', name: 'short-messages' })

describe('parsing a scenario', () => {
  it('reads setup, the fake world, the script, assertions, rubric and the faux script', () => {
    const scenario = parse(`
description: Ada answers a quick question in short messages
smoke: true
bots:
  - name: Ada
    title: Researcher
    instructions: Be brief.
  - name: Linus
    model: anthropic/claude-haiku
groups:
  - name: Launch
    members: [Ada, Linus]
world:
  clock: 2026-03-14T09:00:00Z
  shell:
    - match: "curl .*wttr"
      stdout: "Paris: sunny, 21C"
  pages:
    https://shop.test/:
      title: Shop
      elements:
        - { role: heading, name: Shop }
  tools:
    - name: weather_lookup
      description: Current weather for a city
      result: Sunny, 21C
script:
  - to: Ada
    text: What's the weather in Paris?
  - to: Launch
    text: Morning team
assert:
  - tool_called: bash
  - tool_not_called: { tool: use_computer, bot: Ada }
  - tool_order: [bash, sendMessage]
  - messages: { in: Ada, min: 1, max: 4 }
  - messages: { in: Launch, from: Linus, max: 0 }
  - max_message_length: 280
  - no_silent_answer: Ada
rubric:
  - Sounds like a colleague texting, not a memo
faux:
  Ada:
    - call: { bash: { command: curl wttr.in/Paris } }
    - send: Sunny, 21C
    - end
  Linus:
    - say: Nothing to add
`)

    expect(scenario).toEqual({
      id: 'voice/short-messages',
      suite: 'voice',
      name: 'short-messages',
      description: 'Ada answers a quick question in short messages',
      smoke: true,
      bots: [
        { name: 'Ada', title: 'Researcher', instructions: 'Be brief.', model: null, scripted: false },
        { name: 'Linus', title: null, instructions: '', model: 'anthropic/claude-haiku', scripted: false },
      ],
      groups: [{ name: 'Launch', members: ['Ada', 'Linus'] }],
      world: {
        clock: '2026-03-14T09:00:00Z',
        shell: [{ match: 'curl .*wttr', stdout: 'Paris: sunny, 21C', stderr: '', exitCode: 0 }],
        pages: { 'https://shop.test/': { title: 'Shop', elements: [{ role: 'heading', name: 'Shop' }] } },
        tools: [{ name: 'weather_lookup', description: 'Current weather for a city', result: 'Sunny, 21C' }],
        plugins: {},
      },
      extraction: false,
      memory: [],
      script: [
        { to: 'Ada', text: "What's the weather in Paris?" },
        { to: 'Launch', text: 'Morning team' },
      ],
      assertions: [
        { type: 'tool_called', tool: 'bash' },
        { type: 'tool_not_called', tool: 'use_computer', bot: 'Ada' },
        { type: 'tool_order', tools: ['bash', 'sendMessage'] },
        { type: 'messages', in: 'Ada', min: 1, max: 4 },
        { type: 'messages', in: 'Launch', from: 'Linus', max: 0 },
        { type: 'max_message_length', chars: 280 },
        { type: 'no_silent_answer', in: 'Ada' },
      ],
      rubric: ['Sounds like a colleague texting, not a memo'],
      faux: {
        Ada: [{ tools: [['bash', { command: 'curl wttr.in/Paris' }]] }, { tools: [['sendMessage', { text: 'Sunny, 21C' }]] }, { end: true }],
        Linus: [{ say: 'Nothing to add' }],
      },
      fauxMemory: [],
      routines: [],
    })
  })

  it("reads memory: extraction, scripted bots, the owner's facts, compactions, deletions and memory checks", () => {
    const scenario = parse(`
extraction: true
bots:
  - name: Ada
  - name: Linus
    scripted: true
memory:
  - { bot: Ada, tier: profile, text: "The owner's dog is called Biscuit." }
  - { text: The owner lives in Porto., importance: 4 }
script:
  - { to: Ada, text: hi }
  - compact: Ada
  - forget: biscuit
assert:
  - messages: { in: Ada, from: Ada, matches: Biscuit, max: 0 }
  - memory: { matches: peanut, max: 0 }
  - memory: { in: shared, matches: Porto, min: 1 }
faux:
  Ada: [end]
  Linus: [end]
faux_memory:
  - NONE
  - "new shared profile 4: The owner lives in Porto."
`)

    expect(scenario).toMatchObject({
      extraction: true,
      bots: [{ name: 'Ada', scripted: false }, { name: 'Linus', scripted: true }],
      memory: [
        { bot: 'Ada', tier: 'profile', text: "The owner's dog is called Biscuit.", importance: 3 },
        { bot: null, tier: 'profile', text: 'The owner lives in Porto.', importance: 4 },
      ],
      script: [{ to: 'Ada', text: 'hi' }, { compact: 'Ada' }, { forget: 'biscuit' }],
      assertions: [
        { type: 'messages', in: 'Ada', from: 'Ada', matches: 'Biscuit', max: 0 },
        { type: 'memory', matches: 'peanut', max: 0 },
        { type: 'memory', in: 'shared', matches: 'Porto', min: 1 },
      ],
      fauxMemory: ['NONE', 'new shared profile 4: The owner lives in Porto.'],
    })
  })

  it('rejects memory steps and checks naming no bot, and faux memory answers without extraction', () => {
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ compact: Rex }]')).toThrow(/script\[0\]\.compact: no bot named "Rex"/)
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nmemory: [{ bot: Rex, text: x }]')).toThrow(/memory\[0\]\.bot: no bot named "Rex"/)
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nassert: [{ memory: { in: Rex, matches: x } }]')).toThrow(
      /assert\[0\]: no bot named "Rex"/,
    )
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nfaux_memory: [NONE]')).toThrow(/faux_memory: .*extraction/)
  })

  it("reads routines: the owner's routines, clock moves and routine checks", () => {
    const scenario = parse(`
bots: [{ name: Ada }]
world: { clock: 2026-03-16T08:30:00Z }
routines:
  - { bot: Ada, name: Build watch, prompt: Tell me about failing builds., schedule: "0 9 * * *" }
script:
  - advance: 90m
  - advance: 1d
  - advance: 2026-03-18T09:00:00Z
assert:
  - routines: { bot: Ada, schedule: "^0 8 \\\\* \\\\* 1-5$", prompt: digest, min: 1, max: 1 }
  - routines: { name: dentist, by: bot, ran: true, messaged: false, max: 0 }
`)

    expect(scenario).toMatchObject({
      routines: [{ bot: 'Ada', name: 'Build watch', prompt: 'Tell me about failing builds.', schedule: '0 9 * * *' }],
      script: [{ advance: 90 * 60_000 }, { advance: 24 * 60 * 60_000 }, { advanceTo: '2026-03-18T09:00:00Z' }],
      assertions: [
        { type: 'routines', bot: 'Ada', schedule: '^0 8 \\* \\* 1-5$', prompt: 'digest', min: 1, max: 1 },
        { type: 'routines', name: 'dentist', by: 'bot', ran: true, messaged: false, max: 0 },
      ],
    })
  })

  it('rejects routines and routine checks naming no bot, and clock moves it cannot read', () => {
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nroutines: [{ bot: Rex, name: x, prompt: y, schedule: "@daily" }]')).toThrow(
      /routines\[0\]\.bot: no bot named "Rex"/,
    )
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nassert: [{ routines: { bot: Rex } }]')).toThrow(/assert\[0\]: no bot named "Rex"/)
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ advance: soon }]')).toThrow(/script\[0\]/)
    expect(() => parse('bots: [{ name: Ada }]\nworld: { clock: soon }\nscript: [{ to: Ada, text: hi }]')).toThrow(/world\.clock/)
    expect(() => parse('bots: [{ name: Ada }]\nworld: { clock: 2026-03-16T08:30:00Z }\nscript: [{ advance: 1h }, { advance: 2026-03-16T09:00:00Z }]')).toThrow(
      /script\[1\]\.advance: 2026-03-16T09:00:00Z isn't after the clock \(2026-03-16T09:30:00Z\)/,
    )
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ advance: 2026-03-16T09:00:00Z }]')).toThrow(/script\[0\]\.advance: .*needs world\.clock/)
  })

  it("reads plugins: the catalog's fake servers, their connected accounts and grants, and the owner's decisions", () => {
    const scenario = parse(`
bots: [{ name: Ada }, { name: Linus }]
world:
  plugins:
    notion:
      display_name: Notion
      description: Your Notion workspace
      tools:
        - name: search
          description: Search pages
          result: { Personal: Groceries list, Work: Q3 roadmap }
        - { name: fetch, description: Read a page, result: The page }
      accounts:
        - { name: Personal, granted: [Ada, Linus] }
        - Work
    linear:
      description: Your issues
      tools: [{ name: list_issues, description: List issues, result: "#1 Fix login" }]
script:
  - { to: Ada, text: hi }
  - { decide: Ada, plugin: notion, grant: Work }
  - { decide: Linus, plugin: linear, deny: true }
`)

    expect(scenario.world.plugins).toEqual({
      notion: {
        displayName: 'Notion',
        description: 'Your Notion workspace',
        tools: [
          { name: 'search', description: 'Search pages', result: { Personal: 'Groceries list', Work: 'Q3 roadmap' } },
          { name: 'fetch', description: 'Read a page', result: 'The page' },
        ],
        accounts: [
          { name: 'Personal', granted: ['Ada', 'Linus'] },
          { name: 'Work', granted: [] },
        ],
      },
      linear: { displayName: 'linear', description: 'Your issues', tools: [{ name: 'list_issues', description: 'List issues', result: '#1 Fix login' }], accounts: [] },
    })
    expect(scenario.script.slice(1)).toEqual([
      { decide: 'Ada', plugin: 'notion', grant: 'Work' },
      { decide: 'Linus', plugin: 'linear', deny: true },
    ])
  })

  it('rejects grants and decisions naming no bot, plugin or account', () => {
    const world = (accounts: string) => `world: { plugins: { notion: { description: Notes, tools: [], accounts: ${accounts} } } }`
    expect(() => parse(`bots: [{ name: Ada }]\n${world('[{ name: Work, granted: [Rex] }]')}\nscript: [{ to: Ada, text: hi }]`)).toThrow(
      /world\.plugins\.notion\.accounts\[0\]\.granted: no bot named "Rex"/,
    )
    expect(() => parse(`bots: [{ name: Ada }]\n${world('[Work, Work]')}\nscript: [{ to: Ada, text: hi }]`)).toThrow(/world\.plugins\.notion\.accounts\[1\]: "Work" is already an account/)
    expect(() => parse(`bots: [{ name: Ada }]\n${world('[Work]')}\nscript: [{ decide: Rex, plugin: notion, deny: true }]`)).toThrow(/script\[0\]\.decide: no bot named "Rex"/)
    expect(() => parse(`bots: [{ name: Ada }]\n${world('[Work]')}\nscript: [{ decide: Ada, plugin: linear, deny: true }]`)).toThrow(/script\[0\]\.plugin: no plugin named "linear"/)
    expect(() => parse(`bots: [{ name: Ada }]\n${world('[Work]')}\nscript: [{ decide: Ada, plugin: notion, grant: Home }]`)).toThrow(/script\[0\]\.grant: notion has no account named "Home"/)
    expect(() => parse(`bots: [{ name: Ada }]\n${world('[Work]')}\nscript: [{ decide: Ada, plugin: notion }]`)).toThrow(/script\[0\]/)
  })

  it('fills in defaults for a minimal scenario', () => {
    const scenario = parse(`
bots: [{ name: Ada }]
script: [{ to: Ada, text: hi }]
assert: [no_silent_answer]
`)
    expect(scenario).toMatchObject({
      description: '',
      smoke: false,
      groups: [],
      world: { clock: null, shell: [], pages: {}, tools: [], plugins: {} },
      assertions: [{ type: 'no_silent_answer' }],
      rubric: [],
      faux: {},
      extraction: false,
      memory: [],
      routines: [],
      fauxMemory: [],
    })
  })

  it('rejects names that are neither a bot nor a group, saying where', () => {
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Rex, text: hi }]')).toThrow(/voice\/short-messages.*script\[0\]\.to: no bot or group named "Rex"/s)
    expect(() => parse('bots: [{ name: Ada }, { name: Max }]\ngroups: [{ name: G, members: [Ada, Zed] }]\nscript: [{ to: G, text: hi }]')).toThrow(
      /groups\[0\]\.members: no bot named "Zed"/,
    )
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nassert: [{ tool_called: { tool: bash, bot: Rex } }]')).toThrow(
      /assert\[0\]: no bot named "Rex"/,
    )
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nfaux: { Rex: [end] }')).toThrow(/faux: no bot named "Rex"/)
  })

  it('rejects a malformed scenario with the path of the problem', () => {
    expect(() => parse('bots: [{ name: Ada }]\nscript: []')).toThrow(/script/)
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nassert: [{ tool_caled: bash }]')).toThrow(/assert\[0\]/)
    expect(() => parse('bots: [{ name: Ada }]\nscript: [{ to: Ada, text: hi }]\nfaux: { Ada: [{ shout: hi }] }')).toThrow(/faux/)
  })
})
