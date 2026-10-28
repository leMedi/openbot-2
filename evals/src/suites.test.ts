import { describe, expect, it } from 'vitest'
import { runScenario } from './run.ts'
import { loadScenarios } from './suites.ts'

describe('the suites', () => {
  it('select every scenario, the smoke suite, a suite, or one scenario', () => {
    const all = loadScenarios().map((scenario) => scenario.id)
    expect(new Set(all.map((id) => id.split('/')[0]))).toEqual(new Set(['groups', 'memory', 'tool-priority', 'voice']))
    expect(loadScenarios('smoke').map((scenario) => scenario.id)).toEqual([
      'groups/mention-answers-only-named',
      'tool-priority/fetch-with-shell',
      'voice/short-messages',
    ])
    expect(loadScenarios('voice').every((scenario) => scenario.suite === 'voice')).toBe(true)
    expect(loadScenarios('voice/short-messages').map((scenario) => scenario.id)).toEqual(['voice/short-messages'])
    expect(() => loadScenarios('vioce')).toThrow(/No scenarios match "vioce".*groups, memory, tool-priority, voice/)
  })

  // Their faux scripts play what a well-behaved bot does, so every check passes: it keeps scenarios, their checks and
  // the agent in step. Real models are measured with `pnpm eval`.
  describe.each(loadScenarios().map((scenario) => [scenario.id, scenario] as const))('%s', (_id, scenario) => {
    it('passes on the faux model', async () => {
      const result = await runScenario(scenario, { kind: 'faux' }, { stepTimeoutMs: 20_000 })
      expect(result.error).toBeUndefined()
      expect(result.assertions.filter((assertion) => !assertion.passed)).toEqual([])
      expect(result.rubric.every((item) => item.passed)).toBe(true)
    })
  })
})
