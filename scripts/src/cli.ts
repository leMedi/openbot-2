// The release pipeline's commands (see .github/workflows/release.yml), run with plain Node from the repo root:
//   node scripts/src/cli.ts facts --run <N>               prints the release facts as JSON
//   node scripts/src/cli.ts package --run <N> --out <dir> builds the release into <dir>
// The run number is GitHub Actions' run number (GITHUB_RUN_NUMBER when --run is left out). In CI, the results are also
// written to $GITHUB_OUTPUT for later steps.
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { releaseFacts } from './facts.ts'
import { packageRelease } from './package-release.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { run: { type: 'string' }, out: { type: 'string' } },
})
const repo = process.cwd()
const run = Number(values.run ?? process.env.GITHUB_RUN_NUMBER)

/** Hands values to later steps of a GitHub Actions job. */
function output(outputs: Record<string, string>) {
  if (!process.env.GITHUB_OUTPUT) return
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
}

switch (positionals[0]) {
  case 'facts': {
    const facts = releaseFacts(repo, { run })
    console.log(JSON.stringify(facts, null, 2))
    output({ version: facts.version, runtime: facts.runtime })
    break
  }
  case 'package': {
    if (!values.out) throw new Error('package needs --out <dir>')
    const { manifest, config, archive, manifestFile, checksums, compose, installer, notes } = packageRelease({
      repo,
      out: resolve(values.out),
      run,
    })
    output({
      version: manifest.version,
      tag: `v${manifest.version}`,
      runtime: manifest.minRuntime,
      'runtime-image': manifest.runtimeImage,
      'runtime-repository': config.runtimeImage,
      archive,
      manifest: manifestFile,
      checksums,
      compose,
      installer,
      notes,
    })
    break
  }
  default:
    console.error('usage: node scripts/src/cli.ts facts|package [--run <N>] [--out <dir>]')
    process.exit(2)
}
