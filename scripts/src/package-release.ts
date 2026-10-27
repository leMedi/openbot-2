// Builds a release (design §2.4): the app archive, its manifest and checksums, ready to attach to a GitHub Release and
// to embed in the runtime image.
//
// The archive unpacks into $OPENBOT_APP_DIR/releases/<version>/ and holds:
//   bin/start                 what the runtime image's server program runs (the web app, API and screen streams)
//   release.json              the manifest
//   apps/webapp/dist          the built web app; its server build bundles the web app and the workspace packages
//   apps/desktopd/src         the screen daemon, run with plain Node
//   apps/*, packages/*        the workspace packages' sources (tests left out)
//   node_modules              production dependencies for linux x64 and arm64, installed flat ("hoisted")
//
// Dependencies stay outside the server build and are installed flat so that the build's imports resolve from
// apps/webapp/dist at runtime, and so packages that find their own files keep them: pi-env runs its daemon binary
// from its bin/ folder, libSQL loads a native module, and the database migrations ship with @openbot/db.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { releaseFacts } from './facts.ts'
import { installScript } from './install-script.ts'
import { readReleaseConfig, type ReleaseConfig, releaseManifest, releaseNotes, type ReleaseManifest } from './manifest.ts'

/** Top-level files every release keeps: pnpm's workspace files, so the release can be inspected and reinstalled. */
const rootFiles = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
/** Where the workspace packages live. */
const packageFolders = ['apps/', 'packages/', 'scripts/']
const isTest = (path: string) => /\.test\.tsx?$/.test(path)

/** The platforms the runtime image runs on, whose native dependencies the release carries. */
const platforms = ['supportedArchitectures:', '  os: [linux]', '  cpu: [x64, arm64]', '  libc: [glibc]']

/** The release's files to publish, all in `out`, with its manifest and the config it was built with. */
export type PackagedRelease = {
  manifest: ReleaseManifest
  config: ReleaseConfig
  archive: string
  manifestFile: string
  checksums: string
  /** The compose sample (docker/compose.yml), for the installer. */
  compose: string
  /** The installer (scripts/install.sh) with the config's site and releases URLs as its defaults. */
  installer: string
  /** The GitHub Release's notes. */
  notes: string
}

/** Builds the workspace in `repo`'s working tree (tracked and untracked files, not ignored ones) as CI run `run`'s release into `out`. */
export function packageRelease({
  repo,
  out,
  run,
  environment = process.env,
  createdAt = new Date(),
}: {
  repo: string
  out: string
  run: number
  environment?: Record<string, string | undefined>
  createdAt?: Date
}): PackagedRelease {
  const facts = releaseFacts(repo, { run })
  const config = readReleaseConfig(readFileSync(join(repo, 'release.env'), 'utf8'), environment)
  const manifest = releaseManifest(facts, config, { createdAt })
  const log = (message: string) => console.log(`[release] ${message}`)
  log(`OpenBot ${manifest.version} (runtime ${manifest.minRuntime}, migrations: ${manifest.migrations ? 'yes' : 'no'})`)

  // `out` is emptied first, so it must not be the repo or hold it.
  if (!relative(repo, out) || !relative(out, repo).startsWith('..')) throw new Error(`--out can't hold the repo: ${out}`)
  rmSync(out, { recursive: true, force: true })
  const source = join(out, 'work', 'source')
  const release = join(out, 'work', 'release')

  // 1. Build from a clean copy, with dependencies installed flat as in the release, so the server build leaves them out.
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repo,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => rootFiles.includes(path) || packageFolders.some((folder) => path.startsWith(folder)))
    .filter((path) => existsSync(join(repo, path)))
  for (const path of files) copy(join(repo, path), join(source, path))
  log('building the web app')
  pnpm(source, ['install', '--frozen-lockfile', '--config.node-linker=hoisted'])
  pnpm(source, ['--filter', '@openbot/webapp', 'build'])

  // 2. The release: workspace files, sources without tests, the built web app, and production dependencies.
  for (const path of files) {
    if (!isTest(path)) copy(join(source, path), join(release, path))
  }
  cpSync(join(source, 'apps/webapp/dist'), join(release, 'apps/webapp/dist'), { recursive: true })
  appendFileSync(join(release, 'pnpm-workspace.yaml'), `\n${platforms.join('\n')}\n`)
  log('installing production dependencies for linux x64 and arm64')
  pnpm(release, ['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted'])

  mkdirSync(join(release, 'bin'))
  writeFileSync(join(release, 'bin', 'start'), startScript(manifest.version))
  chmodSync(join(release, 'bin', 'start'), 0o755)
  writeFileSync(join(release, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // 3. What gets published.
  const archive = join(out, manifest.archive)
  log(`packing ${manifest.archive}`)
  // No extended attributes or AppleDouble files: macOS adds its own, which GNU tar warns about when unpacking.
  execFileSync('tar', ['--no-xattrs', '-czf', archive, '-C', release, '.'], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const manifestFile = join(out, 'release.json')
  copyFileSync(join(release, 'release.json'), manifestFile)
  const compose = join(out, 'compose.yml')
  copyFileSync(join(repo, 'docker', 'compose.yml'), compose)
  const installer = join(out, 'install.sh')
  writeFileSync(installer, installScript(readFileSync(join(repo, 'scripts', 'install.sh'), 'utf8'), config), { mode: 0o755 })
  const checksums = join(out, 'SHA256SUMS')
  writeFileSync(
    checksums,
    [archive, manifestFile, compose, installer].map((file) => `${sha256(file)}  ${basename(file)}\n`).join(''),
  )
  const notes = join(out, 'notes.md')
  writeFileSync(notes, releaseNotes(manifest))
  rmSync(join(out, 'work'), { recursive: true, force: true })
  return { manifest, config, archive, manifestFile, checksums, compose, installer, notes }
}

/** The release's `bin/start`, run by the runtime image as `openbot-server` (docker/start-server.sh). */
function startScript(version: string): string {
  return `#!/usr/bin/env bash
# Starts OpenBot ${version}: the web app, the API and screens' streams on $OPENBOT_HOST:$OPENBOT_PORT.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
export NODE_ENV=production OPENBOT_VERSION=${version}
exec node apps/webapp/src/server/start.ts
`
}

function pnpm(cwd: string, args: string[]) {
  execFileSync('pnpm', args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', TURBO_TELEMETRY_DISABLED: '1' },
  })
}

function copy(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
