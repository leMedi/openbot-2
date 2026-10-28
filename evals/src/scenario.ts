import { factTiers, type FactTier } from '@openbot/api-contract'
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
  /**
   * How many messages bots posted in a chat (a bot's DM or a group chat), optionally only `from` one of them, and only
   * those a regex `matches` (case-insensitive); with `last`, only those after the owner's last message there.
   */
  | { type: 'messages'; in: string; from?: string; matches?: string; last?: boolean; min?: number; max?: number }
  /** No bot message longer than `chars` characters: short messages. */
  | { type: 'max_message_length'; chars: number; in?: string }
  /** Every owner message in the chat (every chat when absent) was answered with at least one bot message. */
  | { type: 'no_silent_answer'; in?: string }
  /**
   * How many facts are in memory at the end whose text a regex `matches` (case-insensitive): in shared memory, a bot's
   * bot memory (`in` the bot's name), or anywhere.
   */
  | { type: 'memory'; matches: string; in?: string; min?: number; max?: number }
  /**
   * How many routines there are at the end, of one `bot` or any, written `by` the owner or a bot (who created or last
   * edited them), whose name, prompt and schedule regexes match (case-insensitive).
   */
  | {
      type: 'routines'
      bot?: string
      by?: 'owner' | 'bot'
      name?: string
      prompt?: string
      schedule?: string
      /** Only those with (true) or without (false) a run that ran. */
      ran?: boolean
      /** Only those with (true) or without (false) a run that messaged the owner. */
      messaged?: boolean
      min?: number
      max?: number
    }

/** A fact the owner added before the run: to a bot's bot memory, or to shared memory when `bot` is null. */
export type SeededFact = { bot: string | null; tier: FactTier; text: string; importance: number }

/** A routine the owner set up for a bot before the run. */
export type SeededRoutine = { bot: string; name: string; prompt: string; schedule: string }

/**
 * One step of the script: an owner's message to a bot's DM or a group chat; a compaction of a bot's history, as
 * pi-durable does near the context window; the owner deleting every fact a regex `forget` matches (case-insensitive);
 * or the server's clock moving forward, by `advance` ms or to the instant `advanceTo`, firing the routines due on the
 * way. Every step but `forget` waits until all is quiet.
 */
export type ScriptStep = { to: string; text: string } | { compact: string } | { forget: string } | { advance: number } | { advanceTo: string }

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
  /** A `scripted` bot plays its faux turns on every model, real ones too, and passes once they run out. */
  bots: { name: string; title: string | null; instructions: string; model: string | null; scripted: boolean }[]
  groups: { name: string; members: string[] }[]
  world: {
    /** What `date` on the computer says; bots' prompts carry no date, so it is their only clock. */
    clock: string | null
    shell: ShellRule[]
    pages: Record<string, TestPage>
    tools: FakeTool[]
  }
  /** Extracts memory after every run, on the memory model: the bots' model on real runs, `fauxMemory` on the faux one. */
  extraction: boolean
  /** Facts the owner added before the run. */
  memory: SeededFact[]
  /** Routines the owner set up before the run. */
  routines: SeededRoutine[]
  /** The owner's messages, compactions, memory deletions and clock moves, in order. */
  script: ScriptStep[]
  assertions: Assertion[]
  /** What the eval judge scores the run on, one item each. */
  rubric: string[]
  /** Each bot's turns when the scenario runs on the faux model, by bot name. */
  faux: Record<string, FauxTurn[]>
  /** The memory model's answers on the faux model, one per extraction, in order. */
  fauxMemory: string[]
}

const name = z.string().min(1)
const count = z.number().int().min(0)
const regex = z.string().min(1).refine((source) => {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}, 'not a valid regex')
const bot = z.union([name, z.object({ tool: name, bot: name.optional() }).strict()])
/** `90m`, `2h`, `1d`, in ms. */
const duration = z
  .string()
  .regex(/^\d+[mhd]$/, 'not a duration such as 30m, 2h or 1d')
  .transform((text) => Number.parseInt(text) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[text.at(-1) as 'm' | 'h' | 'd'])
// YAML reads an unquoted timestamp as a date.
const instant = z
  .union([z.string(), z.date().transform((date) => date.toISOString().replace('.000Z', 'Z'))])
  .refine((text) => !Number.isNaN(Date.parse(text)), 'not a time')
const toolCalls = z.record(name, z.record(z.string(), z.unknown()).nullable())

const assertion = z.union([
  z.object({ tool_called: bot }).strict(),
  z.object({ tool_not_called: bot }).strict(),
  z.object({ tool_order: z.union([z.array(name).min(2), z.object({ tools: z.array(name).min(2), bot: name.optional() }).strict()]) }).strict(),
  z
    .object({
      messages: z
        .object({ in: name, from: name.optional(), matches: regex.optional(), last: z.boolean().optional(), min: count.optional(), max: count.optional() })
        .strict(),
    })
    .strict(),
  z.object({ memory: z.object({ matches: regex, in: name.optional(), min: count.optional(), max: count.optional() }).strict() }).strict(),
  z
    .object({
      routines: z
        .object({
          bot: name.optional(),
          by: z.enum(['owner', 'bot']).optional(),
          name: regex.optional(),
          prompt: regex.optional(),
          schedule: regex.optional(),
          ran: z.boolean().optional(),
          messaged: z.boolean().optional(),
          min: count.optional(),
          max: count.optional(),
        })
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
          .object({
            name,
            title: z.string().nullable().default(null),
            instructions: z.string().default(''),
            model: z.string().nullable().default(null),
            scripted: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
    groups: z.array(z.object({ name, members: z.array(name).min(2) }).strict()).default([]),
    world: z
      .object({
        clock: instant.nullable().default(null),
        shell: z
          .array(z.object({ match: z.string(), stdout: z.string().default(''), stderr: z.string().default(''), exitCode: z.number().int().default(0) }).strict())
          .default([]),
        pages: z.record(z.string(), z.object({ title: z.string(), elements: z.array(pageElement) }).strict()).default({}),
        tools: z.array(z.object({ name, description: z.string(), result: z.string() }).strict()).default([]),
      })
      .strict()
      .default({ clock: null, shell: [], pages: {}, tools: [] }),
    extraction: z.boolean().default(false),
    memory: z
      .array(
        z
          .object({
            bot: name.nullable().default(null),
            tier: z.enum(factTiers).default('profile'),
            text: z.string().min(1).max(500),
            importance: z.number().int().min(1).max(5).default(3),
          })
          .strict(),
      )
      .default([]),
    routines: z.array(z.object({ bot: name, name: z.string().min(1), prompt: z.string().min(1), schedule: z.string().min(1) }).strict()).default([]),
    script: z
      .array(
        z.union([
          z.object({ to: name, text: z.string().min(1) }).strict(),
          z.object({ compact: name }).strict(),
          z.object({ forget: regex }).strict(),
          z.object({ advance: z.union([duration, instant], 'not a duration such as 30m, 2h or 1d, or a time') }).strict(),
        ]),
      )
      .min(1),
    assert: z.array(assertion).default([]),
    rubric: z.array(z.string().min(1)).default([]),
    faux: z.record(name, z.array(fauxTurn)).default({}),
    faux_memory: z.array(z.string().min(1)).default([]),
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
  if ('memory' in raw) return { type: 'memory', ...raw.memory }
  if ('routines' in raw) return { type: 'routines', ...raw.routines }
  if ('max_message_length' in raw)
    return { type: 'max_message_length', ...(typeof raw.max_message_length === 'number' ? { chars: raw.max_message_length } : raw.max_message_length) }
  return { type: 'no_silent_answer', ...(raw.no_silent_answer ? { in: raw.no_silent_answer } : {}) }
}

function toScriptStep(raw: Raw['script'][number]): ScriptStep {
  if (!('advance' in raw)) return raw
  return typeof raw.advance === 'number' ? { advance: raw.advance } : { advanceTo: raw.advance }
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
  raw.memory.forEach((fact, i) => {
    if (fact.bot && !bots.has(fact.bot)) problems.push(`memory[${i}].bot: no bot named "${fact.bot}"`)
  })
  raw.routines.forEach((routine, i) => {
    if (!bots.has(routine.bot)) problems.push(`routines[${i}].bot: no bot named "${routine.bot}"`)
  })
  raw.script.forEach((step, i) => {
    if ('to' in step && !chats.has(step.to)) problems.push(`script[${i}].to: no bot or group named "${step.to}"`)
    if ('compact' in step && !bots.has(step.compact)) problems.push(`script[${i}].compact: no bot named "${step.compact}"`)
  })
  problems.push(...backwardMoves(raw))
  raw.assert.map(toAssertion).forEach((assertion, i) => {
    if ('bot' in assertion && assertion.bot && !bots.has(assertion.bot)) problems.push(`assert[${i}]: no bot named "${assertion.bot}"`)
    if ('from' in assertion && assertion.from && !bots.has(assertion.from)) problems.push(`assert[${i}]: no bot named "${assertion.from}"`)
    if (assertion.type === 'memory') {
      if (assertion.in && assertion.in !== 'shared' && !bots.has(assertion.in)) problems.push(`assert[${i}]: no bot named "${assertion.in}"`)
    } else if ('in' in assertion && assertion.in && !chats.has(assertion.in)) problems.push(`assert[${i}]: no bot or group named "${assertion.in}"`)
  })
  for (const bot of Object.keys(raw.faux)) if (!bots.has(bot)) problems.push(`faux: no bot named "${bot}"`)
  if (raw.faux_memory.length && !raw.extraction) problems.push('faux_memory: the memory model only answers with `extraction: true`')
  return problems
}

/** Clock moves to a time that isn't after the clock's, which the clock (never going back) would skip silently. */
function backwardMoves(raw: Raw): string[] {
  const problems: string[] = []
  let now = raw.world.clock === null ? null : Date.parse(raw.world.clock)
  raw.script.forEach((step, i) => {
    if (!('advance' in step)) return
    if (typeof step.advance === 'number') {
      if (now !== null) now += step.advance
      return
    }
    const to = Date.parse(step.advance)
    if (now === null) problems.push(`script[${i}].advance: moving to ${step.advance} needs world.clock, where the clock starts`)
    else if (to <= now) problems.push(`script[${i}].advance: ${step.advance} isn't after the clock (${new Date(now).toISOString().replace('.000Z', 'Z')})`)
    now = to
  })
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
    extraction: raw.extraction,
    memory: raw.memory,
    routines: raw.routines,
    script: raw.script.map(toScriptStep),
    assertions: raw.assert.map(toAssertion),
    rubric: raw.rubric,
    faux: Object.fromEntries(Object.entries(raw.faux).map(([bot, turns]) => [bot, turns.map(toFauxTurn)])),
    fauxMemory: raw.faux_memory,
  }
}

/** `script[0].to` from zod's path. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, key) => (typeof key === 'number' ? `${text}[${key}]` : text ? `${text}.${String(key)}` : String(key)), '') || '(root)'
}
