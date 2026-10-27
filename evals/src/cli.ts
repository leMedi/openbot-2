// pnpm eval [all | smoke | <suite> | <suite>/<scenario>] [--model <provider/model>] [--judge <provider/model>] [--runs <n>]
//           [--report <file.md>] [--json <file.json>] [--record-baseline] [--step-timeout <seconds>]
//
// Runs scenarios against the real agent in a fake world and prints pass rates (evals/README.md). Without --model (or
// OPENBOT_EVAL_MODEL) it runs on the faux model, which plays each scenario's `faux` script: that checks the pipeline
// and the scenarios, not a model.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { builtinModelProviders } from '@openbot/agent'
import { type Baseline, failedChecks, formatReport, type RunResult, summarise } from './report.ts'
import { type EvalModels, runScenario } from './run.ts'
import { ScenarioError } from './scenario.ts'
import { loadScenarios } from './suites.ts'

/** A mistake in how the command was called: reported without a stack trace, as scenarios that can't be used are. */
class UsageError extends Error {}

const usage = (message: string): never => {
  throw new UsageError(message)
}

process.on('uncaughtException', (error) => {
  const expected =
    error instanceof UsageError || error instanceof ScenarioError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
  console.error(expected ? error.message : error)
  process.exit(1)
})

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', default: process.env.OPENBOT_EVAL_MODEL || 'faux' },
    judge: { type: 'string', default: process.env.OPENBOT_EVAL_JUDGE_MODEL },
    runs: { type: 'string', default: '3' },
    report: { type: 'string' },
    json: { type: 'string' },
    'record-baseline': { type: 'boolean', default: false },
    'step-timeout': { type: 'string', default: '300' },
  },
})

const selection = positionals[0] ?? 'all'
const runs = Number.parseInt(values.runs, 10)
if (!(runs > 0)) usage(`--runs must be a positive number, not ${values.runs}`)
const stepTimeoutMs = Number.parseFloat(values['step-timeout']) * 1000
if (!(stepTimeoutMs > 0)) usage(`--step-timeout must be a positive number of seconds, not ${values['step-timeout']}`)
const faux = values.model === 'faux'
if (!faux && !values.model.includes('/')) usage('--model must be provider/model (e.g. anthropic/claude-sonnet-4-5) or faux')
const judge = faux ? 'faux' : (values.judge ?? values.model)
// Faux pass rates measure the scenarios' scripts, not a model: never a baseline.
if (faux && values['record-baseline']) usage('--record-baseline needs a real --model: faux runs check the scenarios and the runner, not a model')

const scenarios = loadScenarios(selection)
const models: EvalModels = faux
  ? { kind: 'faux' }
  : { kind: 'real', model: values.model, judge, env: process.env, providers: await builtinModelProviders() }

/** Baselines are recorded per model, next to the suites. */
const baselineFile = join(import.meta.dirname, '..', 'baselines', `${values.model.replace(/[^\w.-]+/g, '_')}.json`)
type BaselineFile = { model: string; judge: string; runs: number; recordedAt: string; passRates: Baseline }
const readBaseline = (): BaselineFile | undefined => {
  try {
    return JSON.parse(readFileSync(baselineFile, 'utf8')) as BaselineFile
  } catch {
    return undefined
  }
}

console.error(`Running ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} × ${runs} on ${values.model} (judge ${judge})`)
const results: RunResult[] = []
for (const scenario of scenarios) {
  for (let run = 1; run <= runs; run++) {
    const started = Date.now()
    const result = await runScenario(scenario, models, { run, stepTimeoutMs })
    const failed = failedChecks(result).map(({ check, detail }) => (check === 'run' ? detail : check))
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.error(`${failed.length ? '✗' : '✓'} ${scenario.id} #${run} (${seconds} s)${failed.length ? `: ${failed.join('; ')}` : ''}`)
    const { record: _record, world: _world, ...summary } = result
    results.push(summary)
  }
}

const summary = summarise(results)
const baseline = readBaseline()
const report = formatReport(summary, {
  title: `Evals: ${selection}, ${runs} run${runs === 1 ? '' : 's'} each${faux ? ' (faux model: checks the scenarios and the runner, not a model)' : ''}`,
  model: values.model,
  judge,
  baseline: baseline?.passRates,
})
console.log(`\n${report}`)

const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
if (values.report) write(values.report, `${report}\n`)
if (values.json) write(values.json, `${JSON.stringify({ model: values.model, judge, runs, selection, summary, results }, null, 2)}\n`)
if (values['record-baseline']) {
  // Scenarios not run this time keep their recorded rate.
  const passRates = { ...baseline?.passRates, ...Object.fromEntries(summary.scenarios.map((scenario) => [scenario.scenario, scenario.passRate])) }
  const recorded: BaselineFile = { model: values.model, judge, runs, recordedAt: new Date().toISOString(), passRates }
  write(baselineFile, `${JSON.stringify(recorded, null, 2)}\n`)
  console.error(`Recorded the baseline in ${baselineFile}`)
}
