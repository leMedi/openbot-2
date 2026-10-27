import { describe, expect, it } from 'vitest'
import { readReleaseConfig, releaseManifest, releaseNotes } from './manifest.ts'

const facts = {
  version: '0.1.42',
  commit: 'a'.repeat(40),
  runtime: 'r7',
  previous: { version: '0.1.41', commit: 'b'.repeat(40) },
  migrations: true,
  changelog: [
    { commit: 'aaaaaaa', subject: 'Group chats (#18)' },
    { commit: 'ccccccc', subject: 'Fix a typo' },
  ],
}
const config = { siteUrl: 'https://openbot.lemedi.dev', runtimeImage: 'ghcr.io/lemedi/openbot-runtime' }

describe('the release manifest', () => {
  it('names the version, the minimum runtime image, the migrations flag and the changelog', () => {
    const manifest = releaseManifest(facts, config, { createdAt: new Date('2026-10-27T05:00:00Z') })

    expect(manifest).toEqual({
      version: '0.1.42',
      commit: 'a'.repeat(40),
      createdAt: '2026-10-27T05:00:00.000Z',
      archive: 'openbot-0.1.42.tar.gz',
      minRuntime: 'r7',
      runtimeImage: 'ghcr.io/lemedi/openbot-runtime:r7',
      migrations: true,
      previous: '0.1.41',
      siteUrl: 'https://openbot.lemedi.dev',
      changelog: facts.changelog,
    })
  })

  it('becomes the GitHub Release’s notes', () => {
    const manifest = releaseManifest(facts, config, { createdAt: new Date('2026-10-27T05:00:00Z') })

    expect(releaseNotes(manifest)).toBe(
      [
        'Changes since 0.1.41:',
        '',
        '- Group chats (#18) (aaaaaaa)',
        '- Fix a typo (ccccccc)',
        '',
        'Needs runtime image `ghcr.io/lemedi/openbot-runtime:r7` or newer. Adds database migrations.',
        '',
      ].join('\n'),
    )
  })
})

describe('the shared release config', () => {
  it('comes from release.env, where each value can be overridden by the environment', () => {
    const text = [
      '# comment',
      'OPENBOT_SITE_URL=https://openbot.lemedi.dev',
      'OPENBOT_RUNTIME_IMAGE=ghcr.io/lemedi/openbot-runtime',
    ].join('\n')

    expect(readReleaseConfig(text, {})).toEqual(config)
    expect(readReleaseConfig(text, { OPENBOT_SITE_URL: 'https://bots.example.com/', OPENBOT_RUNTIME_IMAGE: '' })).toEqual({
      siteUrl: 'https://bots.example.com',
      runtimeImage: 'ghcr.io/lemedi/openbot-runtime',
    })
  })

  it('refuses a site URL that is not http(s)', () => {
    expect(() => readReleaseConfig('OPENBOT_SITE_URL=openbot\nOPENBOT_RUNTIME_IMAGE=x/y', {})).toThrow(/OPENBOT_SITE_URL/)
  })
})
