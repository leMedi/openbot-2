import { chmod, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Plugin, PluginSkill } from './catalog.ts'

/** Where `installSkills` copies `plugin`'s `skill` in `pluginsDir`: its folder, as in the catalog. */
const installedSkillFolder = (pluginsDir: string, plugin: string, skill: PluginSkill) => join(pluginsDir, plugin, 'skills', basename(skill.folder))

/** The `SKILL.md` of `plugin`'s `skill` as `installSkills` copies it in `pluginsDir`, where bots read it. */
export const installedSkillFile = (pluginsDir: string, plugin: string, skill: PluginSkill) => join(installedSkillFolder(pluginsDir, plugin, skill), 'SKILL.md')

/**
 * Copies every plugin's skills to `<pluginsDir>/<plugin>/skills/<folder>/` (design §2.3), replacing what an earlier
 * release copied there and removing the folders of plugins no longer in the catalog. The server owns the copies, so
 * bots, as another user, can only read them; files are also read-only for the server, folders world-readable.
 */
export async function installSkills(plugins: readonly Plugin[], pluginsDir: string): Promise<void> {
  await mkdir(pluginsDir, { recursive: true, mode: 0o755 })
  const names = new Set(plugins.map((plugin) => plugin.name))
  for (const entry of await readdir(pluginsDir)) {
    if (!names.has(entry)) await rm(join(pluginsDir, entry), { recursive: true, force: true })
  }
  for (const plugin of plugins) {
    const folder = join(pluginsDir, plugin.name)
    await rm(folder, { recursive: true, force: true })
    await mkdir(join(folder, 'skills'), { recursive: true, mode: 0o755 })
    for (const skill of plugin.skills) {
      // By the folder's name, as in the catalog: a skill's own name could be anything.
      const copy = installedSkillFolder(pluginsDir, plugin.name, skill)
      await cp(skill.folder, copy, { recursive: true, dereference: true })
      await makeReadOnly(copy)
    }
  }
}

/** Folders 0755 and files 0444 under `folder`. */
async function makeReadOnly(folder: string): Promise<void> {
  await chmod(folder, 0o755)
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) await makeReadOnly(path)
    else await chmod(path, 0o444)
  }
}
