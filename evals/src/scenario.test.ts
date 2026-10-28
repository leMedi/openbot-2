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
      world: { clock: null, shell: [], pages: {}, tools: [] },
      assertions: [{ type: 'no_silent_answer' }],
      rubric: [],
      faux: {},
      extraction: false,
      memory: [],
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
