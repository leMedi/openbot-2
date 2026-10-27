import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseScenario, type Scenario, ScenarioError } from './scenario.ts'

/** Where the suites live: one folder per suite, one YAML file per scenario. */
const suitesDir = join(import.meta.dirname, '..', 'suites')

/**
 * The scenarios `selection` names, in suite then file order: `all`, `smoke` (those marked `smoke: true`), a suite's
 * name, or one scenario's `<suite>/<name>`.
 */
export function loadScenarios(selection = 'all'): Scenario[] {
  const all = readdirSync(suitesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((suite) =>
      readdirSync(join(suitesDir, suite))
        .filter((file) => file.endsWith('.yaml'))
        .sort()
        .map((file) => parseScenario(readFileSync(join(suitesDir, suite, file), 'utf8'), { suite, name: file.slice(0, -'.yaml'.length) })),
    )
  const selected =
    selection === 'all'
      ? all
      : selection === 'smoke'
        ? all.filter((scenario) => scenario.smoke)
        : all.filter((scenario) => scenario.suite === selection || scenario.id === selection)
  if (!selected.length) {
    const suites = [...new Set(all.map((scenario) => scenario.suite))]
    throw new ScenarioError(`No scenarios match "${selection}". Pick all, smoke, a suite (${suites.join(', ')}) or <suite>/<scenario>.`)
  }
  return selected
}
