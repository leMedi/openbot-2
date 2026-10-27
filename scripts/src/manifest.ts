// A release's manifest, `release.json` (design §2.4): attached to the GitHub Release and shipped inside the archive.
// The installer and the updater read it.
import { parseEnv } from 'node:util'
import type { ChangelogEntry, ReleaseFacts } from './facts.ts'

/** The shared release config (`release.env` at the repo root). */
export type ReleaseConfig = {
  /** Where the installer is served from, e.g. https://openbot.lemedi.dev. */
  siteUrl: string
  /** The runtime image's repository, without a tag. */
  runtimeImage: string
  /** Where releases are downloaded from: `<releasesUrl>/latest/download/<file>`, `<releasesUrl>/download/v<version>/<file>`. */
  releasesUrl: string
}

export type ReleaseManifest = {
  version: string
  commit: string
  createdAt: string
  /** The app archive's file name, next to this manifest in the release. */
  archive: string
  /** The oldest runtime image revision (`r<N>`) this release works with. */
  minRuntime: string
  /** That image, in full. */
  runtimeImage: string
  /** Whether installing this release applies new database migrations. */
  migrations: boolean
  /** The version the changelog starts from, if any. */
  previous?: string
  siteUrl: string
  changelog: ChangelogEntry[]
}

/** `release.env`'s values, each overridden by a non-empty variable of the same name (CI passes repo variables). */
export function readReleaseConfig(text: string, environment: Record<string, string | undefined>): ReleaseConfig {
  const file = parseEnv(text)
  const value = (name: string) => {
    const found = environment[name] || file[name]
    if (!found) throw new Error(`release.env must set ${name}`)
    return found
  }
  /** An http(s) URL, without trailing slashes. */
  const httpUrl = (name: string) => {
    const url = value(name).replace(/\/+$/, '')
    if (!/^https?:\/\/[^/]+/.test(url)) throw new Error(`${name} must be an http(s) URL: ${url}`)
    return url
  }
  return {
    siteUrl: httpUrl('OPENBOT_SITE_URL'),
    runtimeImage: value('OPENBOT_RUNTIME_IMAGE'),
    releasesUrl: httpUrl('OPENBOT_RELEASES_URL'),
  }
}

export function releaseManifest(
  facts: ReleaseFacts,
  config: ReleaseConfig,
  { createdAt }: { createdAt: Date },
): ReleaseManifest {
  return {
    version: facts.version,
    commit: facts.commit,
    createdAt: createdAt.toISOString(),
    archive: archiveName(facts.version),
    minRuntime: facts.runtime,
    runtimeImage: `${config.runtimeImage}:${facts.runtime}`,
    migrations: facts.migrations,
    previous: facts.previous?.version,
    siteUrl: config.siteUrl,
    changelog: facts.changelog,
  }
}

export function archiveName(version: string): string {
  return `openbot-${version}.tar.gz`
}

/** The GitHub Release's notes, in Markdown. */
export function releaseNotes(manifest: ReleaseManifest): string {
  return [
    manifest.previous ? `Changes since ${manifest.previous}:` : 'Changes:',
    '',
    ...manifest.changelog.map((entry) => `- ${entry.subject} (${entry.commit})`),
    '',
    `Needs runtime image \`${manifest.runtimeImage}\` or newer.` +
      (manifest.migrations ? ' Adds database migrations.' : ''),
    '',
  ].join('\n')
}
