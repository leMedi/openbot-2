import { z } from 'zod'
import type { RunRecord } from './run-record.ts'

/** The judge's verdict on one rubric item. */
export type RubricResult = { item: string; passed: boolean; reason: string }

const systemPrompt = `You grade how an AI bot behaved in an eval scenario. The bot is one of the owner's always-on bots; it reaches the owner only through chat messages, and its tool calls are private.

You get the scenario, every chat's messages, the bots' tool calls, what they remember at the end, their routines (instructions that wake them on a schedule) at the end, and a numbered rubric. Judge each rubric item on the evidence alone; when the evidence doesn't clearly meet an item, it fails.

Answer with JSON only, no other text:
{"verdicts": [{"item": <number>, "pass": <true or false>, "reason": "<one short sentence>"}]}`

/** The judge's request: what happened in a run, and the rubric to score it on. */
export function judgeRequest({ description, rubric, record }: { description: string; rubric: string[]; record: RunRecord }) {
  const lines = [`Scenario: ${description || '(no description)'}`]
  for (const [chat, messages] of Object.entries(record.chats)) {
    lines.push('', `Chat "${chat}":`)
    if (!messages.length) lines.push('(no messages)')
    for (const message of messages)
      lines.push(
        message.from === 'timeline'
          ? `(timeline, not a message) ${message.text}`
          : `${message.author}${message.from === 'between_bots' ? ' (to another bot)' : ''}: ${message.text}`,
      )
  }
  lines.push('', 'Tool calls (private, the owner never sees them):')
  if (!record.toolCalls.length) lines.push('(none)')
  for (const call of record.toolCalls) lines.push(`- ${call.bot}: ${call.tool} ${JSON.stringify(call.args)}`)
  lines.push('', 'Memory at the end (facts the bots remember):')
  if (!record.memory.length) lines.push('(none)')
  for (const fact of record.memory) {
    const where = fact.in === 'shared' ? 'shared memory' : `${fact.in}'s memory`
    lines.push(`- ${where}, ${fact.tier}, by ${fact.source === 'owner' ? 'the owner' : fact.source}: ${fact.text}`)
  }
  lines.push('', 'Routines at the end:')
  if (!record.routines.length) lines.push('(none)')
  for (const routine of record.routines) {
    const by = routine.by === 'owner' ? 'the owner' : routine.bot
    const runs = routine.runs.length ? `runs: ${routine.runs.map((run) => `${run.status}${run.messaged ? ' (messaged the owner)' : ''}`).join(', ')}` : 'never ran'
    lines.push(`- ${routine.bot}'s ${JSON.stringify(routine.name)}, by ${by}, ${routine.enabled ? 'on' : 'off'}, schedule ${routine.schedule}, ${runs}: ${routine.prompt}`)
  }
  lines.push('', 'Rubric:', ...rubric.map((item, i) => `${i + 1}. ${item}`))
  return { systemPrompt, prompt: lines.join('\n') }
}

const answerSchema = z.object({
  verdicts: z.array(z.object({ item: z.number().int(), pass: z.boolean(), reason: z.string().default('') })),
})

/** One verdict per rubric item from the judge's answer; an item it didn't judge, or couldn't, fails. */
export function parseVerdicts(answer: string, rubric: string[]): RubricResult[] {
  const json = answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)
  let parsed: z.infer<typeof answerSchema> | undefined
  try {
    parsed = answerSchema.parse(JSON.parse(json))
  } catch {
    const excerpt = answer.trim().slice(0, 200)
    return rubric.map((item) => ({ item, passed: false, reason: `The judge's answer wasn't JSON: ${excerpt}` }))
  }
  return rubric.map((item, i) => {
    const verdict = parsed.verdicts.find((candidate) => candidate.item === i + 1)
    return verdict ? { item, passed: verdict.pass, reason: verdict.reason } : { item, passed: false, reason: 'The judge gave no verdict' }
  })
}
