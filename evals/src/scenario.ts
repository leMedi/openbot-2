import type { TestPage } from '@openbot/core/testing'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/** A shell command's scripted result in the fake world: the first rule whose `match` (a regex) finds the command wins. */
export type ShellRule = { match: string; stdout: string; stderr: string; exitCode: number }

/** A fake tool server's tool: bots get it beside their built-in tools, and every call answers `result`. */
export type FakeTool = { name: string; description: string; result: string }

/** One model response on the faux model: tool calls, private text ending the run, or ending it silently. */
export type FauxTurn = { tools: [name: string, args: Record<string, unknown>][] } | { say: string } | { end: true }

/** A deterministic check of what happened in a run. Bot and chat names are the scenario's. */
export type Assertion =
  | { type: 'tool_called'; tool: string; bot?: string }
  | { type: 'tool_not_called'; tool: string; bot?: string }
  /** The tools' first calls happened in this order. */
  | { type: 'tool_order'; tools: string[]; bot?: string }
  /** How many messages bots posted in a chat (a bot's DM or a group chat), optionally only `from` one of them. */
  | { type: 'messages'; in: string; from?: string; min?: number; max?: number }
  /** No bot message longer than `chars` characters: short messages. */
  | { type: 'max_message_length'; chars: number; in?: string }
  /** Every owner message in the chat (every chat when absent) was answered with at least one bot message. */
  | { type: 'no_silent_answer'; in?: string }

/** A scenario file, or a selection of scenarios, that can't be used; its message says why. */
export class ScenarioError extends Error {}

/** What a scenario sets up, sends and checks; see evals/README.md for its YAML. */
export type Scenario = {
  /** `<suite>/<name>`. */
  id: string
  suite: string
  name: string
  description: string
  /** Part of the smoke suite CI runs. */
  smoke: boolean
  bots: { name: string; title: string | null; instructions: string; model: string | null }[]
  groups: { name: string; members: string[] }[]
  world: {
    /** What `date` on the computer says; bots' prompts carry no date, so it is their only clock. */
    clock: string | null
    shell: ShellRule[]
    pages: Record<string, TestPage>
    tools: FakeTool[]
  }
  /** The owner's messages, in order: each goes to a bot's DM or a group chat, and the next waits until all is quiet. */
  script: { to: string; text: string }[]
  assertions: Assertion[]
  /** What the eval judge scores the run on, one item each. */
  rubric: string[]
  /** Each bot's turns when the scenario runs on the faux model, by bot name. */
  faux: Record<string, FauxTurn[]>
}

const name = z.string().min(1)
const bot = z.union([name, z.object({ tool: name, bot: name.optional() }).strict()])
const toolCalls = z.record(name, z.record(z.string(), z.unknown()).nullable())

const assertion = z.union([
  z.object({ tool_called: bot }).strict(),
  z.object({ tool_not_called: bot }).strict(),
  z.object({ tool_order: z.union([z.array(name).min(2), z.object({ tools: z.array(name).min(2), bot: name.optional() }).strict()]) }).strict(),
  z
    .object({
      messages: z
        .object({ in: name, from: name.optional(), min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() })
        .strict(),
    })
    .strict(),
  z.object({ max_message_length: z.union([z.number().int().positive(), z.object({ chars: z.number().int().positive(), in: name.optional() }).strict()]) }).strict(),
  z.object({ no_silent_answer: name.nullable() }).strict(),
  z.literal('no_silent_answer'),
])

const fauxTurn = z.union([
  z.object({ call: toolCalls }).strict(),
  z.object({ send: z.string() }).strict(),
  z.object({ say: z.string() }).strict(),
  z.literal('end'),
])

const pageElement = z.union([
  z.object({ role: z.enum(['heading', 'text']), name: z.string() }).strict(),
  z.object({ role: z.literal('link'), name: z.string(), href: z.string() }).strict(),
  z.object({ role: z.literal('button'), name: z.string(), href: z.string().optional() }).strict(),
  z.object({ role: z.literal('textbox'), name: z.string() }).strict(),
])

const schema = z
  .object({
    description: z.string().default(''),
    smoke: z.boolean().default(false),
    bots: z
      .array(
        z
          .object({ name, title: z.string().nullable().default(null), instructions: z.string().default(''), model: z.string().nullable().default(null) })
          .strict(),
      )
      .min(1),
    groups: z.array(z.object({ name, members: z.array(name).min(2) }).strict()).default([]),
    world: z
      .object({
        // YAML reads an unquoted timestamp as a date.
        clock: z.union([z.string(), z.date().transform((date) => date.toISOString().replace('.000Z', 'Z'))]).nullable().default(null),
        shell: z
          .array(z.object({ match: z.string(), stdout: z.string().default(''), stderr: z.string().default(''), exitCode: z.number().int().default(0) }).strict())
          .default([]),
        pages: z.record(z.string(), z.object({ title: z.string(), elements: z.array(pageElement) }).strict()).default({}),
        tools: z.array(z.object({ name, description: z.string(), result: z.string() }).strict()).default([]),
      })
      .strict()
      .default({ clock: null, shell: [], pages: {}, tools: [] }),
    script: z.array(z.object({ to: name, text: z.string().min(1) }).strict()).min(1),
    assert: z.array(assertion).default([]),
    rubric: z.array(z.string().min(1)).default([]),
    faux: z.record(name, z.array(fauxTurn)).default({}),
  })
  .strict()

type Raw = z.infer<typeof schema>

function toAssertion(raw: Raw['assert'][number]): Assertion {
  if (raw === 'no_silent_answer') return { type: 'no_silent_answer' }
  if ('tool_called' in raw) return { type: 'tool_called', ...(typeof raw.tool_called === 'string' ? { tool: raw.tool_called } : raw.tool_called) }
  if ('tool_not_called' in raw)
    return { type: 'tool_not_called', ...(typeof raw.tool_not_called === 'string' ? { tool: raw.tool_not_called } : raw.tool_not_called) }
  if ('tool_order' in raw) return { type: 'tool_order', ...(Array.isArray(raw.tool_order) ? { tools: raw.tool_order } : raw.tool_order) }
  if ('messages' in raw) return { type: 'messages', ...raw.messages }
  if ('max_message_length' in raw)
    return { type: 'max_message_length', ...(typeof raw.max_message_length === 'number' ? { chars: raw.max_message_length } : raw.max_message_length) }
  return { type: 'no_silent_answer', ...(raw.no_silent_answer ? { in: raw.no_silent_answer } : {}) }
}

function toFauxTurn(raw: Raw['faux'][string][number]): FauxTurn {
  if (raw === 'end') return { end: true }
  if ('say' in raw) return { say: raw.say }
  if ('send' in raw) return { tools: [['sendMessage', { text: raw.send }]] }
  return { tools: Object.entries(raw.call).map(([tool, args]) => [tool, args ?? {}]) }
}

/** Names in the scenario that don't exist, as messages saying where. */
function unknownNames(raw: Raw): string[] {
  const bots = new Set(raw.bots.map((bot) => bot.name))
  const chats = new Set([...bots, ...raw.groups.map((group) => group.name)])
  const problems: string[] = []
  raw.groups.forEach((group, i) => {
    for (const member of group.members) if (!bots.has(member)) problems.push(`groups[${i}].members: no bot named "${member}"`)
  })
  raw.script.forEach((step, i) => {
    if (!chats.has(step.to)) problems.push(`script[${i}].to: no bot or group named "${step.to}"`)
  })
  raw.assert.map(toAssertion).forEach((assertion, i) => {
    if ('bot' in assertion && assertion.bot && !bots.has(assertion.bot)) problems.push(`assert[${i}]: no bot named "${assertion.bot}"`)
    if ('from' in assertion && assertion.from && !bots.has(assertion.from)) problems.push(`assert[${i}]: no bot named "${assertion.from}"`)
    if ('in' in assertion && assertion.in && !chats.has(assertion.in)) problems.push(`assert[${i}]: no bot or group named "${assertion.in}"`)
  })
  for (const bot of Object.keys(raw.faux)) if (!bots.has(bot)) problems.push(`faux: no bot named "${bot}"`)
  return problems
}

/** A scenario from its YAML, or an error naming the scenario and every problem's path. */
export function parseScenario(yaml: string, { suite, name }: { suite: string; name: string }): Scenario {
  const id = `${suite}/${name}`
  const parsed = schema.safeParse(parseYaml(yaml))
  const problems = parsed.success ? unknownNames(parsed.data) : parsed.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
  if (!parsed.success || problems.length) throw new ScenarioError(`Scenario ${id} is invalid:\n- ${problems.join('\n- ')}`)
  const raw = parsed.data
  return {
    id,
    suite,
    name,
    description: raw.description,
    smoke: raw.smoke,
    bots: raw.bots,
    groups: raw.groups,
    world: raw.world,
    script: raw.script,
    assertions: raw.assert.map(toAssertion),
    rubric: raw.rubric,
    faux: Object.fromEntries(Object.entries(raw.faux).map(([bot, turns]) => [bot, turns.map(toFauxTurn)])),
  }
}

/** `script[0].to` from zod's path. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, key) => (typeof key === 'number' ? `${text}[${key}]` : text ? `${text}.${String(key)}` : String(key)), '') || '(root)'
}
