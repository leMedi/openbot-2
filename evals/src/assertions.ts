import type { Assertion } from './scenario.ts'
import type { ChatMessage, RunRecord } from './run-record.ts'

/** An assertion's outcome: its label for the report, and what was seen. */
export type AssertionResult = { label: string; passed: boolean; detail: string }

const byBot = (bot: string | undefined) => (bot ? ` (${bot})` : '')
const times = (count: number) => `${count} ${count === 1 ? 'time' : 'times'}`
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** What the label shows of a message count's bounds: `1–4`, `at least 1`, `at most 0`. */
function bounds(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${min}–${max}`
  if (min !== undefined) return `at least ${min}`
  if (max !== undefined) return `at most ${max}`
  return 'any number'
}

/** What a label shows of a regex: ` matching /x/`, or nothing. */
const matching = (regex: string | undefined) => (regex ? ` matching /${regex}/` : '')
/** Whether `text` has a match of the case-insensitive `regex`; any text does without one. */
const matches = (regex: string | undefined, text: string) => !regex || new RegExp(regex, 'i').test(text)
/** Whether `count` is within the bounds. */
const within = (count: number, { min, max }: { min?: number; max?: number }) => count >= (min ?? 0) && count <= (max ?? Infinity)
/** `2 facts: a, b`, or `0 facts`. */

const listed = (count: number, word: string, items: string[]) => `${plural(count, word)}${items.length ? `: ${items.join(', ')}` : ''}`

/**
 * The messages bots sent the owner, in one chat or every chat, with the chat's name; with `last`, only those after the
 * owner's last message in each chat.
 */
function botMessages(record: RunRecord, chat?: string, last = false): (ChatMessage & { chat: string })[] {
  return Object.entries(record.chats)
    .filter(([name]) => !chat || name === chat)
    .flatMap(([name, messages]) =>
      messages
        .slice(last ? messages.map((message) => message.from).lastIndexOf('owner') + 1 : 0)
        .filter((message) => message.from === 'bot')
        .map((message) => ({ ...message, chat: name })),
    )
}

/** Checks one assertion against what a run left behind. */
export function checkAssertion(assertion: Assertion, record: RunRecord): AssertionResult {
  switch (assertion.type) {
    case 'tool_called':
    case 'tool_not_called': {
      const calls = record.toolCalls.filter((call) => call.tool === assertion.tool && (!assertion.bot || call.bot === assertion.bot))
      const label = `${assertion.type} ${assertion.tool}${byBot(assertion.bot)}`
      const passed = assertion.type === 'tool_called' ? calls.length > 0 : calls.length === 0
      if (!calls.length) return { label, passed, detail: 'never called' }
      const first = calls[0]!
      const detail = assertion.type === 'tool_called' ? `called ${times(calls.length)}` : `called ${times(calls.length)}: ${first.bot} ${first.tool} ${JSON.stringify(first.args)}`
      return { label, passed, detail }
    }
    case 'tool_order': {
      const label = `tool_order ${assertion.tools.join(' → ')}${byBot(assertion.bot)}`
      const tools = record.toolCalls.filter((call) => !assertion.bot || call.bot === assertion.bot).map((call) => call.tool)
      const missing = assertion.tools.find((tool) => !tools.includes(tool))
      if (missing) return { label, passed: false, detail: `${missing} was never called` }
      const firsts = [...assertion.tools].sort((a, b) => tools.indexOf(a) - tools.indexOf(b))
      const passed = firsts.every((tool, i) => tool === assertion.tools[i])
      return { label, passed, detail: `first calls in order: ${firsts.join(', ')}` }
    }
    case 'messages': {
      const label = `messages in ${assertion.in}${assertion.from ? ` from ${assertion.from}` : ''}${assertion.last ? " after the owner's last" : ''}${matching(assertion.matches)}: ${bounds(assertion.min, assertion.max)}`
      const found = botMessages(record, assertion.in, assertion.last).filter(
        (message) => (!assertion.from || message.author === assertion.from) && matches(assertion.matches, message.text),
      )
      const passed = within(found.length, assertion)
      return { label, passed, detail: assertion.matches ? listed(found.length, 'message', found.map((message) => JSON.stringify(message.text))) : plural(found.length, 'message') }
    }
    case 'memory': {
      const label = `memory${assertion.in ? ` in ${assertion.in}` : ''}${matching(assertion.matches)}: ${bounds(assertion.min, assertion.max)}`
      const found = record.memory.filter((fact) => (!assertion.in || fact.in === assertion.in) && matches(assertion.matches, fact.text))
      const passed = within(found.length, assertion)
      return { label, passed, detail: listed(found.length, 'fact', found.map((fact) => `${fact.in} ${JSON.stringify(fact.text)}`)) }
    }
    case 'routines': {
      const filters = (['name', 'prompt', 'schedule'] as const).filter((field) => assertion[field] !== undefined)
      const label = [
        'routines',
        assertion.bot && ` of ${assertion.bot}`,
        assertion.by && ` by ${assertion.by === 'owner' ? 'the owner' : 'a bot'}`,
        filters.length > 0 && ` with ${filters.map((field) => `${field} /${assertion[field]}/`).join(', ')}`,
        assertion.ran !== undefined && (assertion.ran ? ' that ran' : " that didn't run"),
        assertion.messaged !== undefined && (assertion.messaged ? (assertion.ran ? ', messaging the owner' : ' that messaged the owner') : assertion.ran ? ', without messaging the owner' : " that didn't message the owner"),
        `: ${bounds(assertion.min, assertion.max)}`,
      ]
        .filter(Boolean)
        .join('')
      const found = record.routines.filter(
        (routine) =>
          (!assertion.bot || routine.bot === assertion.bot) &&
          (!assertion.by || routine.by === assertion.by) &&
          filters.every((field) => matches(assertion[field], routine[field])) &&
          (assertion.ran === undefined || routine.runs.some((run) => run.status === 'ran') === assertion.ran) &&
          (assertion.messaged === undefined || routine.runs.some((run) => run.messaged) === assertion.messaged),
      )
      const passed = within(found.length, assertion)
      const described = found.map(
        (routine) => `${routine.bot} ${JSON.stringify(routine.name)} (${routine.schedule}, by ${routine.by === 'owner' ? 'the owner' : routine.bot}): ${JSON.stringify(routine.prompt)}`,
      )
      return { label, passed, detail: listed(found.length, 'routine', described) }
    }
    case 'granted_tools_only': {
      const label = 'granted_tools_only'
      const answered = record.pluginCalls.map((call) => call.tool)
      // Each answered call accounts for one of the bots' calls of its tool; those left over never reached a server.
      const refused = record.toolCalls.filter((call) => {
        if (!call.tool.startsWith('mcp__')) return false
        const i = answered.indexOf(call.tool)
        if (i !== -1) answered.splice(i, 1)
        return i === -1
      })
      if (!refused.length) return { label, passed: true, detail: 'every plugin tool call was granted' }
      return { label, passed: false, detail: `not granted: ${refused.map((call) => `${call.bot} ${call.tool}`).join(', ')}` }
    }
    case 'max_message_length': {
      const label = `max_message_length ${assertion.chars}${assertion.in ? ` in ${assertion.in}` : ''}`
      const long = botMessages(record, assertion.in).filter((message) => message.text.length > assertion.chars)
      if (!long.length) return { label, passed: true, detail: 'all short enough' }
      const first = long[0]!
      return { label, passed: false, detail: `${long.length} longer: ${first.chat}, ${first.author} (${first.text.length} chars): ${JSON.stringify(first.text)}` }
    }
    case 'no_silent_answer': {
      const label = `no_silent_answer${assertion.in ? ` in ${assertion.in}` : ''}`
      const unanswered = Object.entries(record.chats)
        .filter(([name]) => !assertion.in || name === assertion.in)
        .flatMap(([, messages]) =>
          messages.filter((message, i) => {
            if (message.from !== 'owner') return false
            const next = messages.findIndex((later, j) => j > i && later.from === 'owner')
            return !messages.slice(i + 1, next === -1 ? undefined : next).some((later) => later.from === 'bot')
          }),
        )
      if (!unanswered.length) return { label, passed: true, detail: 'every owner message answered' }
      return { label, passed: false, detail: `unanswered: ${unanswered.map((message) => JSON.stringify(message.text)).join(', ')}` }
    }
  }
}
