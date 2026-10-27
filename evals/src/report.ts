import type { AssertionResult } from './assertions.ts'
import type { RubricResult } from './judge.ts'

/** One run of one scenario: its checks, or the error that stopped it. */
export type RunResult = { scenario: string; run: number; assertions: AssertionResult[]; rubric: RubricResult[]; error?: string }

export type ScenarioSummary = {
  scenario: string
  runs: number
  passed: number
  passRate: number
  /** The checks that failed, most often first, with how many runs they failed and the first failure's detail. */
  failures: { check: string; count: number; example: string }[]
}

export type Summary = {
  scenarios: ScenarioSummary[]
  /** A suite's pass rate is its scenarios' mean, so each scenario counts the same whatever its runs. */
  suites: { suite: string; scenarios: number; passRate: number }[]
  passRate: number
}

/** Pass rates in a baseline, by scenario id. */
export type Baseline = Record<string, number>

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)

/** A run's failed checks: the error that stopped it, failed assertions, failed rubric items. */
export function failedChecks(result: RunResult): { check: string; detail: string }[] {
  if (result.error) return [{ check: 'run', detail: result.error }]
  return [
    ...result.assertions.filter((assertion) => !assertion.passed).map((assertion) => ({ check: assertion.label, detail: assertion.detail })),
    ...result.rubric.filter((item) => !item.passed).map((item) => ({ check: `judge: ${item.item}`, detail: item.reason })),
  ]
}

/** Pass rates per scenario (in the order they first ran), per suite and overall; a run passes when every check did. */
export function summarise(results: RunResult[]): Summary {
  const byScenario = new Map<string, RunResult[]>()
  for (const result of results) byScenario.set(result.scenario, [...(byScenario.get(result.scenario) ?? []), result])

  const scenarios = [...byScenario].map(([scenario, runs]): ScenarioSummary => {
    const failures = new Map<string, { check: string; count: number; example: string }>()
    let passed = 0
    for (const run of runs) {
      const failed = failedChecks(run)
      if (!failed.length) passed++
      for (const { check, detail } of failed) {
        const failure = failures.get(check) ?? { check, count: 0, example: detail }
        failure.count++
        failures.set(check, failure)
      }
    }
    return { scenario, runs: runs.length, passed, passRate: passed / runs.length, failures: [...failures.values()].sort((a, b) => b.count - a.count) }
  })

  const suiteOf = (scenario: string) => scenario.split('/')[0]!
  const suites = [...new Set(scenarios.map((summary) => suiteOf(summary.scenario)))].map((suite) => {
    const members = scenarios.filter((summary) => suiteOf(summary.scenario) === suite)
    return { suite, scenarios: members.length, passRate: mean(members.map((summary) => summary.passRate)) }
  })

  return { scenarios, suites, passRate: mean(scenarios.map((summary) => summary.passRate)) }
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

/** The pass rates as Markdown, for the terminal, a file and the release notes; ▼ marks a scenario below its baseline. */
export function formatReport(summary: Summary, { title, model, judge, baseline }: { title: string; model: string; judge: string; baseline?: Baseline }): string {
  const lines = [
    `### ${title}`,
    '',
    `Model \`${model}\`, judge \`${judge}\`. Overall pass rate: **${percent(summary.passRate)}** (${summary.scenarios.length} scenario${summary.scenarios.length === 1 ? '' : 's'}).`,
    '',
    baseline ? '| Scenario | Pass rate | Baseline | Failing checks |' : '| Scenario | Pass rate | Failing checks |',
    baseline ? '| --- | --- | --- | --- |' : '| --- | --- | --- |',
  ]
  for (const scenario of summary.scenarios) {
    const rate = `${percent(scenario.passRate)} (${scenario.passed}/${scenario.runs})`
    const failing = scenario.failures.map((failure) => cell(`${failure.check} ×${failure.count}: ${failure.example}`)).join('<br>')
    const before = baseline?.[scenario.scenario]
    const compared = before === undefined ? '–' : `${percent(before)}${scenario.passRate < before ? ' ▼' : ''}`
    lines.push(baseline ? `| ${scenario.scenario} | ${rate} | ${compared} | ${failing} |` : `| ${scenario.scenario} | ${rate} | ${failing} |`)
  }
  lines.push('', '| Suite | Scenarios | Pass rate |', '| --- | --- | --- |')
  for (const suite of summary.suites) lines.push(`| ${suite.suite} | ${suite.scenarios} | ${percent(suite.passRate)} |`)
  return lines.join('\n')
}
