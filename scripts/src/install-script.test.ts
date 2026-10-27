import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installScript } from './install-script.ts'
import { readReleaseConfig } from './manifest.ts'

const repo = join(import.meta.dirname, '..', '..')
const source = readFileSync(join(repo, 'scripts', 'install.sh'), 'utf8')
const config = {
  siteUrl: 'https://openbot.example.org',
  runtimeImage: 'ghcr.io/someone/openbot-runtime',
  releasesUrl: 'https://github.com/someone/openbot/releases',
}

describe('the published installer', () => {
  it('defaults to the release config’s site and releases', () => {
    const script = installScript(source, config)

    expect(script).toContain('\ndefault_site_url=https://openbot.example.org\n')
    expect(script).toContain('\ndefault_releases_url=https://github.com/someone/openbot/releases\n')
    expect(script).not.toContain('openbot.lemedi.dev')
  })

  it('changes nothing else', () => {
    const script = installScript(source, config)

    const otherLines = (text: string) => text.split('\n').filter((line) => !/^default_(site|releases)_url=/.test(line))
    expect(otherLines(script)).toEqual(otherLines(source))
  })

  it('refuses a script without the default lines, rather than publishing one that ignores the config', () => {
    expect(() => installScript('#!/usr/bin/env bash\necho hi\n', config)).toThrow(/default_site_url/)
  })

  it('in the repo, defaults to release.env, so running it from a checkout installs the same releases', () => {
    const fromReleaseEnv = readReleaseConfig(readFileSync(join(repo, 'release.env'), 'utf8'), {})

    expect(installScript(source, fromReleaseEnv)).toBe(source)
  })
})
