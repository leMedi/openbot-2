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
  memory: [
    { in: 'shared', tier: 'profile', text: 'The owner lives in Porto.', source: 'owner' },
    { in: 'Ada', tier: 'note', text: 'Checked the weather in Paris for the owner.', source: 'Ada' },
    { in: 'Linus', tier: 'log', text: 'The owner is moving to Porto in June.', source: 'Linus' },
  ],
  routines: [
    { bot: 'Ada', name: 'Morning digest', prompt: "Send the owner a digest of the night's build failures.", schedule: '0 8 * * 1-5', enabled: true, by: 'bot', runs: [] },
    { bot: 'Linus', name: 'Build watch', prompt: 'Check CI.', schedule: '0 9 * * *', enabled: true, by: 'owner', runs: [{ status: 'ran', messaged: false }] },
  ],
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

  it('count only the messages a regex matches, ignoring case', () => {
    expect(check({ type: 'messages', in: 'Ada', from: 'Ada', matches: 'sunny|rain', min: 1 })).toEqual({
      label: 'messages in Ada from Ada matching /sunny|rain/: at least 1',
      passed: true,
      detail: '1 message: "Sunny"',
    })
    expect(check({ type: 'messages', in: 'Launch', matches: 'red', max: 0 })).toMatchObject({ passed: true, detail: '0 messages' })
  })

  it("count only the answer to the owner's last message in the chat", () => {
    expect(check({ type: 'messages', in: 'Ada', last: true, max: 0 })).toEqual({
      label: "messages in Ada after the owner's last: at most 0",
      passed: true,
      detail: '0 messages',
    })
    expect(check({ type: 'messages', in: 'Launch', last: true, matches: 'green', min: 1 })).toMatchObject({ passed: true })
  })

  it('count the facts in memory a regex matches: in shared memory, one bot\'s, or anywhere', () => {
    expect(check({ type: 'memory', matches: 'porto', min: 2 })).toEqual({
      label: 'memory matching /porto/: at least 2',
      passed: true,
      detail: '2 facts: shared "The owner lives in Porto.", Linus "The owner is moving to Porto in June."',
    })
    expect(check({ type: 'memory', in: 'shared', matches: 'porto', max: 0 })).toMatchObject({
      label: 'memory in shared matching /porto/: at most 0',
      passed: false,
    })
    expect(check({ type: 'memory', in: 'Ada', matches: 'peanut', max: 0 })).toEqual({
      label: 'memory in Ada matching /peanut/: at most 0',
      passed: true,
      detail: '0 facts',
    })
  })

  it('count the routines at the end: one bot\'s or any, by the owner or a bot, by name, prompt and schedule', () => {
    expect(check({ type: 'routines', bot: 'Ada', schedule: '^0 8 \\* \\* (1-5|mon-fri)$', prompt: 'digest', min: 1, max: 1 })).toEqual({
      label: 'routines of Ada with prompt /digest/, schedule /^0 8 \\* \\* (1-5|mon-fri)$/: 1–1',
      passed: true,
      detail: '1 routine: Ada "Morning digest" (0 8 * * 1-5, by Ada): "Send the owner a digest of the night\'s build failures."',
    })
    expect(check({ type: 'routines', by: 'bot', max: 0 })).toMatchObject({ label: 'routines by a bot: at most 0', passed: false })
    expect(check({ type: 'routines', by: 'owner', name: 'build', min: 1 })).toMatchObject({ label: 'routines by the owner with name /build/: at least 1', passed: true })
    expect(check({ type: 'routines', bot: 'Linus', schedule: '^at ', min: 1 })).toEqual({
      label: 'routines of Linus with schedule /^at /: at least 1',
      passed: false,
      detail: '0 routines',
    })
  })

  it('count only the routines that ran, or ran and messaged the owner', () => {
    expect(check({ type: 'routines', ran: true, messaged: false, min: 1, max: 1 })).toEqual({
      label: 'routines that ran, without messaging the owner: 1–1',
      passed: true,
      detail: '1 routine: Linus "Build watch" (0 9 * * *, by the owner): "Check CI."',
    })
    expect(check({ type: 'routines', bot: 'Linus', messaged: true, min: 1 })).toMatchObject({ label: 'routines of Linus that messaged the owner: at least 1', passed: false })
    expect(check({ type: 'routines', ran: false, max: 0 })).toMatchObject({ label: "routines that didn't run: at most 0", passed: false })
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
