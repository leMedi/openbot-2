import { describe, expect, it } from 'vitest'
import { judgeRequest, parseVerdicts } from './judge.ts'

const rubric = ['Sounds like a colleague texting', 'Says where the number came from']

describe('the eval judge', () => {
  it('is shown the scenario, what happened in each chat, the tool calls and the numbered rubric', () => {
    const { systemPrompt, prompt } = judgeRequest({
      description: 'Ada answers a weather question',
      rubric,
      record: {
        toolCalls: [{ bot: 'Ada', tool: 'bash', args: { command: 'curl wttr.in/Paris' } }],
        chats: {
          Ada: [
            { from: 'owner', author: 'You', text: 'Weather in Paris?' },
            { from: 'bot', author: 'Ada', text: 'Sunny, 21C' },
            { from: 'between_bots', author: 'Ada', text: 'FYI it is sunny' },
          ],
        },
        memory: [],
        routines: [],
      },
    })

    expect(systemPrompt).toMatch(/JSON/)
    expect(prompt).toBe(
      [
        'Scenario: Ada answers a weather question',
        '',
        'Chat "Ada":',
        'You: Weather in Paris?',
        'Ada: Sunny, 21C',
        'Ada (to another bot): FYI it is sunny',
        '',
        'Tool calls (private, the owner never sees them):',
        '- Ada: bash {"command":"curl wttr.in/Paris"}',
        '',
        'Memory at the end (facts the bots remember):',
        '(none)',
        '',
        'Routines at the end:',
        '(none)',
        '',
        'Rubric:',
        '1. Sounds like a colleague texting',
        '2. Says where the number came from',
      ].join('\n'),
    )
  })

  it('is shown the facts in memory at the end, with where they are and who wrote them', () => {
    const { prompt } = judgeRequest({
      description: '',
      rubric,
      record: {
        toolCalls: [],
        chats: {},
        memory: [
          { in: 'shared', tier: 'profile', text: 'The owner lives in Porto.', source: 'owner' },
          { in: 'Ada', tier: 'note', text: 'Checked the weather.', source: 'Ada' },
        ],
        routines: [],
      },
    })

    expect(prompt).toContain(
      [
        'Memory at the end (facts the bots remember):',
        '- shared memory, profile, by the owner: The owner lives in Porto.',
        "- Ada's memory, note, by Ada: Checked the weather.",
      ].join('\n'),
    )
  })

  it('is shown timeline rows, and the routines at the end with who wrote them, their schedule and runs', () => {
    const { prompt } = judgeRequest({
      description: '',
      rubric,
      record: {
        toolCalls: [],
        chats: { Ada: [{ from: 'timeline', author: 'Ada', text: 'Ada created routine *Dentist*' }] },
        memory: [],
        routines: [
          { bot: 'Ada', name: 'Build watch', prompt: 'Tell me about failing builds.', schedule: '0 9 * * *', enabled: true, by: 'owner', runs: [{ status: 'ran', messaged: true }, { status: 'skipped_overlap', messaged: false }] },
          { bot: 'Ada', name: 'Dentist', prompt: 'Remind the owner to call the dentist.', schedule: 'at 2026-03-16T10:00', enabled: false, by: 'bot', runs: [] },
        ],
      },
    })

    expect(prompt).toContain(['Chat "Ada":', '(timeline, not a message) Ada created routine *Dentist*'].join('\n'))
    expect(prompt).toContain(
      [
        'Routines at the end:',
        '- Ada\'s "Build watch", by the owner, on, schedule 0 9 * * *, runs: ran (messaged the owner), skipped_overlap: Tell me about failing builds.',
        '- Ada\'s "Dentist", by Ada, off, schedule at 2026-03-16T10:00, never ran: Remind the owner to call the dentist.',
      ].join('\n'),
    )
  })

  it('reads one verdict per rubric item from its JSON answer, even wrapped in prose or a code block', () => {
    const answer = 'Here you go:\n```json\n{"verdicts": [{"item": 1, "pass": true, "reason": "Casual"}, {"item": 2, "pass": false, "reason": "No source"}]}\n```'
    expect(parseVerdicts(answer, rubric)).toEqual([
      { item: 'Sounds like a colleague texting', passed: true, reason: 'Casual' },
      { item: 'Says where the number came from', passed: false, reason: 'No source' },
    ])
  })

  it('fails items it gave no verdict for, and every item when its answer is unreadable', () => {
    expect(parseVerdicts('{"verdicts": [{"item": 2, "pass": true, "reason": "ok"}]}', rubric)).toEqual([
      { item: 'Sounds like a colleague texting', passed: false, reason: 'The judge gave no verdict' },
      { item: 'Says where the number came from', passed: true, reason: 'ok' },
    ])
    expect(parseVerdicts('I think it was fine', rubric)).toEqual([
      { item: 'Sounds like a colleague texting', passed: false, reason: 'The judge\'s answer wasn\'t JSON: I think it was fine' },
      { item: 'Says where the number came from', passed: false, reason: 'The judge\'s answer wasn\'t JSON: I think it was fine' },
    ])
  })
})
