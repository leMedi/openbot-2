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

/** The messages bots sent the owner, in one chat or every chat, with the chat's name. */
function botMessages(record: RunRecord, chat?: string): (ChatMessage & { chat: string })[] {
  return Object.entries(record.chats)
    .filter(([name]) => !chat || name === chat)
    .flatMap(([name, messages]) => messages.filter((message) => message.from === 'bot').map((message) => ({ ...message, chat: name })))
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
      const label = `messages in ${assertion.in}${assertion.from ? ` from ${assertion.from}` : ''}: ${bounds(assertion.min, assertion.max)}`
      const count = botMessages(record, assertion.in).filter((message) => !assertion.from || message.author === assertion.from).length
      const passed = count >= (assertion.min ?? 0) && count <= (assertion.max ?? Infinity)
      return { label, passed, detail: plural(count, 'message') }
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
