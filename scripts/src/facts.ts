// What a release is, worked out from the repo's git history (design §2.4): its version, the runtime image it needs,
// and what changed since the previous release. CI checks out main with full history and tags.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ChangelogEntry = { commit: string; subject: string }

export type ReleaseFacts = {
  /** `0.<minor>.<run>`. */
  version: string
  /** The full commit hash the release is built from. */
  commit: string
  /** The runtime image revision (`r<N>`) this commit defines; the release needs at least that image. */
  runtime: string
  /** The latest earlier release on this commit's history, if any. */
  previous?: { version: string; commit: string }
  /** Whether the release adds or changes database migrations since the previous one. */
  migrations: boolean
  /** Main's changes since the previous release, newest first. */
  changelog: ChangelogEntry[]
}

/**
 * What defines the runtime image: `docker/`, except the dev setup and compose files, which don't go into it. Each
 * commit on main's first-parent history that changes these is one revision, so `r<N>` only moves when the image does.
 */
export const runtimeDefinition = ['docker', ':(exclude)docker/dev', ':(exclude)docker/compose*.yml']

/** Where the database migrations live. */
const migrationsFolder = 'packages/db/drizzle'

/** How many changes a changelog lists at most (the first release would otherwise list all of history). */
const changelogLimit = 100

/** The release facts of `repo`'s HEAD, for CI run number `run`. */
export function releaseFacts(repo: string, { run }: { run: number }): ReleaseFacts {
  if (!Number.isSafeInteger(run) || run < 1) throw new Error(`The run number must be a positive whole number: ${run}`)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

  const version = `${minorVersion(readFileSync(join(repo, 'VERSION'), 'utf8'))}.${run}`
  const runtime = `r${git('rev-list', '--count', '--first-parent', 'HEAD', '--', ...runtimeDefinition)}`

  const previousTag = git('tag', '--merged', 'HEAD', '--list', 'v[0-9]*', '--sort=-v:refname')
    .split('\n')
    .find((tag) => tag !== '' && tag !== `v${version}`)
  const previous = previousTag
    ? { version: previousTag.slice(1), commit: git('rev-list', '-n', '1', previousTag) }
    : undefined

  const range = previous ? `${previous.commit}..HEAD` : 'HEAD'
  const changedMigrations = previous
    ? git('diff', '--name-only', previous.commit, 'HEAD', '--', migrationsFolder)
    : git('ls-tree', '-r', '--name-only', 'HEAD', '--', migrationsFolder)
  const log = git('log', '--first-parent', `--max-count=${changelogLimit}`, '--format=%h%x1f%s', range, '--')

  return {
    version,
    commit: git('rev-parse', 'HEAD'),
    runtime,
    previous,
    migrations: changedMigrations !== '',
    changelog: log
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [commit, subject] = line.split('\x1f') as [string, string]
        return { commit, subject: changeSummary(subject) }
      }),
  }
}

/** `0.<minor>` from the VERSION file. */
function minorVersion(text: string): string {
  const version = text.trim()
  if (!/^0\.(0|[1-9]\d*)$/.test(version)) throw new Error(`VERSION must hold 0.<minor>, e.g. 0.1; found "${version}"`)
  return version
}

/** A merge's summary (`Merge branch 'x': group chats (#18)` → `Group chats (#18)`); other subjects as they are. */
function changeSummary(subject: string): string {
  const summary = subject.match(/^Merge branch '[^']+'(?: into \S+)?: (.+)$/)?.[1] ?? subject
  return summary.charAt(0).toUpperCase() + summary.slice(1)
}
