// The installer as published (design §2.5): scripts/install.sh with its defaults, the site URL and where releases are
// downloaded from, set from the release config, so changing domains or repos needs no code change.
import type { ReleaseConfig } from './manifest.ts'

/** `source` (scripts/install.sh) with its `default_site_url=` and `default_releases_url=` lines set from `config`. */
export function installScript(source: string, config: ReleaseConfig): string {
  const defaults = { default_site_url: config.siteUrl, default_releases_url: config.releasesUrl }
  let script = source
  for (const [name, value] of Object.entries(defaults)) {
    const line = new RegExp(`^${name}=.*$`, 'm')
    if (!line.test(script)) throw new Error(`install.sh has no ${name}= line to set`)
    script = script.replace(line, `${name}=${value}`)
  }
  return script
}
