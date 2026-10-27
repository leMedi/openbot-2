import { describe, expect, it } from 'vitest'
import { formatReport, summarise, type RunResult } from './report.ts'

const ok = (label: string) => ({ label, passed: true, detail: 'ok' })
const bad = (label: string, detail: string) => ({ label, passed: false, detail })

const results: RunResult[] = [
  { scenario: 'voice/short', run: 1, assertions: [ok('no_silent_answer')], rubric: [{ item: 'Casual', passed: true, reason: 'yes' }] },
  { scenario: 'voice/short', run: 2, assertions: [bad('no_silent_answer', 'unanswered: "hi"')], rubric: [{ item: 'Casual', passed: false, reason: 'Stiff' }] },
  { scenario: 'voice/short', run: 3, assertions: [bad('no_silent_answer', 'unanswered: "yo"')], rubric: [{ item: 'Casual', passed: true, reason: 'yes' }] },
  { scenario: 'voice/files', run: 1, assertions: [ok('tool_called sendMessage')], rubric: [] },
  { scenario: 'groups/pass', run: 1, assertions: [], rubric: [], error: 'Timed out after 300 s' },
]

describe('pass rates', () => {
  it('counts a run as passed only when every assertion and rubric item passed, per scenario and per suite', () => {
    const summary = summarise(results)

    expect(summary.scenarios).toEqual([
      {
        scenario: 'voice/short',
        runs: 3,
        passed: 1,
        passRate: 1 / 3,
        failures: [
          { check: 'no_silent_answer', count: 2, example: 'unanswered: "hi"' },
          { check: 'judge: Casual', count: 1, example: 'Stiff' },
        ],
      },
      { scenario: 'voice/files', runs: 1, passed: 1, passRate: 1, failures: [] },
      { scenario: 'groups/pass', runs: 1, passed: 0, passRate: 0, failures: [{ check: 'run', count: 1, example: 'Timed out after 300 s' }] },
    ])
    expect(summary.suites).toEqual([
      { suite: 'voice', scenarios: 2, passRate: 2 / 3 },
      { suite: 'groups', scenarios: 1, passRate: 0 },
    ])
    expect(summary.passRate).toBe((1 / 3 + 1 + 0) / 3)
  })
})

describe('the report', () => {
  it('is a Markdown table of pass rates with the failing checks, compared with a baseline when there is one', () => {
    const report = formatReport(summarise(results), {
      title: 'Evals: voice, groups',
      model: 'anthropic/claude-sonnet',
      judge: 'anthropic/claude-haiku',
      baseline: { 'voice/short': 1, 'voice/files': 1 },
    })

    expect(report).toBe(
      [
        '### Evals: voice, groups',
        '',
        'Model `anthropic/claude-sonnet`, judge `anthropic/claude-haiku`. Overall pass rate: **44%** (3 scenarios).',
        '',
        '| Scenario | Pass rate | Baseline | Failing checks |',
        '| --- | --- | --- | --- |',
        '| voice/short | 33% (1/3) | 100% ▼ | no_silent_answer ×2: unanswered: "hi"<br>judge: Casual ×1: Stiff |',
        '| voice/files | 100% (1/1) | 100% |  |',
        '| groups/pass | 0% (0/1) | – | run ×1: Timed out after 300 s |',
        '',
        '| Suite | Scenarios | Pass rate |',
        '| --- | --- | --- |',
        '| voice | 2 | 67% |',
        '| groups | 1 | 0% |',
      ].join('\n'),
    )
  })

  it('escapes table cells', () => {
    const report = formatReport(
      summarise([{ scenario: 's/a', run: 1, assertions: [bad('x', 'a | b\nc')], rubric: [] }]),
      { title: 'Evals', model: 'm', judge: 'j' },
    )
    expect(report).toContain('| x ×1: a \\| b c |')
  })
})
