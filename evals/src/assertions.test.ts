import { describe, expect, it } from 'vitest'
import { checkAssertion } from './assertions.ts'
import type { RunRecord } from './run-record.ts'

const record: RunRecord = {
  toolCalls: [
    { bot: 'Ada', tool: 'bash', args: { command: 'curl wttr.in/Paris' } },
    { bot: 'Ada', tool: 'sendMessage', args: { text: 'Sunny' } },
    { bot: 'Linus', tool: 'use_computer', args: { goal: 'Check the weather' } },
    { bot: 'Ada', tool: 'sendMessage', args: { text: 'And warm' } },
  ],
  chats: {
    Ada: [
      { from: 'owner', author: 'You', text: 'Weather in Paris?' },
      { from: 'bot', author: 'Ada', text: 'Sunny' },
      { from: 'bot', author: 'Ada', text: 'And warm' },
      { from: 'between_bots', author: 'Ada', text: 'Linus, can you double-check?' },
      { from: 'owner', author: 'You', text: 'Thanks' },
    ],
    Linus: [{ from: 'between_bots', author: 'Ada', text: 'Linus, can you double-check?' }],
    Launch: [
      { from: 'owner', author: 'You', text: 'Morning' },
      { from: 'bot', author: 'Linus', text: 'Morning! The build is green and the release notes are drafted, ready for review.' },
    ],
  },
}

const check = (assertion: Parameters<typeof checkAssertion>[0]) => checkAssertion(assertion, record)

describe('deterministic assertions', () => {
  it('check whether a tool was called, by anyone or by one bot', () => {
    expect(check({ type: 'tool_called', tool: 'bash' })).toEqual({ label: 'tool_called bash', passed: true, detail: 'called 1 time' })
    expect(check({ type: 'tool_called', tool: 'use_computer', bot: 'Ada' })).toEqual({
      label: 'tool_called use_computer (Ada)',
      passed: false,
      detail: 'never called',
    })
    expect(check({ type: 'tool_not_called', tool: 'use_computer', bot: 'Ada' })).toMatchObject({ passed: true })
    expect(check({ type: 'tool_not_called', tool: 'use_computer' })).toEqual({
      label: 'tool_not_called use_computer',
      passed: false,
      detail: 'called 1 time: Linus use_computer {"goal":"Check the weather"}',
    })
  })

  it('check the order of tools\' first calls', () => {
    expect(check({ type: 'tool_order', tools: ['bash', 'sendMessage'] })).toMatchObject({ passed: true })
    expect(check({ type: 'tool_order', tools: ['sendMessage', 'bash'], bot: 'Ada' })).toEqual({
      label: 'tool_order sendMessage → bash (Ada)',
      passed: false,
      detail: 'first calls in order: bash, sendMessage',
    })
    expect(check({ type: 'tool_order', tools: ['bash', 'read'] })).toMatchObject({ passed: false, detail: 'read was never called' })
  })

  it('count the messages bots posted to the owner in a chat, ignoring messages between bots', () => {
    expect(check({ type: 'messages', in: 'Ada', min: 1, max: 4 })).toEqual({ label: 'messages in Ada: 1–4', passed: true, detail: '2 messages' })
    expect(check({ type: 'messages', in: 'Ada', max: 1 })).toMatchObject({ label: 'messages in Ada: at most 1', passed: false })
    expect(check({ type: 'messages', in: 'Launch', from: 'Ada', max: 0 })).toEqual({
      label: 'messages in Launch from Ada: at most 0',
      passed: true,
      detail: '0 messages',
    })
    expect(check({ type: 'messages', in: 'Launch', from: 'Linus', min: 1 })).toMatchObject({ label: 'messages in Launch from Linus: at least 1', passed: true })
  })

  it('check that bots\' messages are short', () => {
    expect(check({ type: 'max_message_length', chars: 40, in: 'Ada' })).toMatchObject({ passed: true })
    expect(check({ type: 'max_message_length', chars: 40 })).toEqual({
      label: 'max_message_length 40',
      passed: false,
      detail: '1 longer: Launch, Linus (80 chars): "Morning! The build is green and the release notes are drafted, ready for review."',
    })
  })

  it('check that every owner message was answered with a message', () => {
    expect(check({ type: 'no_silent_answer', in: 'Launch' })).toMatchObject({ label: 'no_silent_answer in Launch', passed: true })
    expect(check({ type: 'no_silent_answer', in: 'Ada' })).toEqual({ label: 'no_silent_answer in Ada', passed: false, detail: 'unanswered: "Thanks"' })
    expect(check({ type: 'no_silent_answer' })).toMatchObject({ label: 'no_silent_answer', passed: false })
  })
})
