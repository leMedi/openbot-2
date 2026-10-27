import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { releaseFacts } from './facts.ts'

/** A throwaway git repo shaped like OpenBot's: a VERSION file, docker/, migrations. */
let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function commit(subject: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  git('add', '--all')
  git('commit', '--quiet', '--message', subject)
  return git('rev-parse', 'HEAD')
}

/** Merges a branch with one commit into main without fast-forwarding, as the repo's history does. */
function merge(branch: string, subject: string, files: Record<string, string>): string {
  git('checkout', '--quiet', '-b', branch)
  commit(`${branch} work`, files)
  git('checkout', '--quiet', 'main')
  git('merge', '--quiet', '--no-ff', branch, '--message', subject)
  return git('rev-parse', 'HEAD')
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'openbot-facts-'))
  git('init', '--quiet', '--initial-branch', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'tag.gpgsign', 'false')
  commit('Start', {
    VERSION: '0.1\n',
    'docker/Dockerfile': 'FROM ubuntu\n',
    'packages/db/drizzle/0000_init.sql': 'create table a (id int);\n',
  })
})

describe('the version', () => {
  it('is 0.<minor>.<run>, with the minor from the VERSION file', () => {
    expect(releaseFacts(repo, { run: 42 }).version).toBe('0.1.42')
  })

  it('increases with every run, and bumping the VERSION file changes the minor', () => {
    const before = releaseFacts(repo, { run: 41 }).version
    commit('Next minor', { VERSION: '0.2\n' })
    const after = releaseFacts(repo, { run: 42 }).version

    expect([before, after]).toEqual(['0.1.41', '0.2.42'])
  })

  it('refuses a VERSION file that is not 0.<minor>', () => {
    commit('Bad version', { VERSION: '1.2.3\n' })

    expect(() => releaseFacts(repo, { run: 1 })).toThrow(/VERSION/)
  })

  it('refuses a run that is not a positive whole number', () => {
    expect(() => releaseFacts(repo, { run: 0 })).toThrow(/run/)
  })
})

describe('the runtime image revision', () => {
  it('counts the changes to the runtime image definition on main', () => {
    expect(releaseFacts(repo, { run: 1 }).runtime).toBe('r1')

    merge('image', 'Merge branch image', { 'docker/entrypoint.sh': 'echo hi\n' })
    expect(releaseFacts(repo, { run: 2 }).runtime).toBe('r2')
  })

  it('stays the same when only the app, the dev setup or compose files change', () => {
    commit('App work', { 'apps/webapp/main.ts': 'export {}\n' })
    commit('Dev work', { 'docker/dev/setup.sh': 'echo dev\n', 'docker/compose.dev.yml': 'name: dev\n' })
    commit('Compose sample', { 'docker/compose.yml': 'name: openbot\n' })

    expect(releaseFacts(repo, { run: 4 }).runtime).toBe('r1')
  })
})

describe('since the previous release', () => {
  it('lists main’s changes since the previous release as the changelog, merges by their summary', () => {
    commit('Old work', { 'a.txt': 'a' })
    git('tag', 'v0.1.1')
    commit('Fix a typo', { 'b.txt': 'b' })
    merge('leMedi/issue-18-group-chats', "Merge branch 'leMedi/issue-18-group-chats': group chats (#18)", {
      'c.txt': 'c',
    })
    const head = git('rev-parse', 'HEAD')

    const facts = releaseFacts(repo, { run: 3 })

    expect(facts.previous).toEqual({ version: '0.1.1', commit: git('rev-parse', 'v0.1.1') })
    expect(facts.commit).toBe(head)
    expect(facts.changelog).toEqual([
      { commit: head.slice(0, 7), subject: 'Group chats (#18)' },
      { commit: expect.stringMatching(/^[0-9a-f]{7}$/), subject: 'Fix a typo' },
    ])
  })

  it('flags migrations only when the release adds or changes some', () => {
    git('tag', 'v0.1.1')
    commit('No schema change', { 'a.txt': 'a' })
    expect(releaseFacts(repo, { run: 2 }).migrations).toBe(false)

    commit('New table', { 'packages/db/drizzle/0001_b.sql': 'create table b (id int);\n' })
    expect(releaseFacts(repo, { run: 3 }).migrations).toBe(true)
  })

  it('is everything on main for the first release, which has migrations', () => {
    commit('Second', { 'a.txt': 'a' })

    const facts = releaseFacts(repo, { run: 1 })

    expect(facts.previous).toBeUndefined()
    expect(facts.migrations).toBe(true)
    expect(facts.changelog.map((entry) => entry.subject)).toEqual(['Second', 'Start'])
  })

  it('ignores the tag of this very version, so a rerun of the same run sees the same previous release', () => {
    git('tag', 'v0.1.1')
    commit('More', { 'a.txt': 'a' })
    git('tag', 'v0.1.2')

    expect(releaseFacts(repo, { run: 2 }).previous?.version).toBe('0.1.1')
  })

  it('ignores newer releases that are not on this commit’s history', () => {
    git('tag', 'v0.1.1')
    git('checkout', '--quiet', '-b', 'elsewhere')
    commit('Elsewhere', { 'x.txt': 'x' })
    git('tag', 'v0.1.9')
    git('checkout', '--quiet', 'main')
    commit('Here', { 'a.txt': 'a' })

    expect(releaseFacts(repo, { run: 10 }).previous?.version).toBe('0.1.1')
  })
})
