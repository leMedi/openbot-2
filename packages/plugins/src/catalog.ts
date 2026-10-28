import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** The catalog shipped with this release: `catalog/` at the root of the repo or release, beside `packages/`. */
export const bundledCatalog = join(dirname(createRequire(import.meta.url).resolve('@openbot/plugins/package.json')), '..', '..', 'catalog')

/** A hosted MCP server a plugin brings. */
export type PluginServer = {
  /** Its key in `.mcp.json`. */
  name: string
  /** Its Streamable HTTP endpoint, `${CLAUDE_PLUGIN_ROOT}` expanded. */
  url: string
}

/** A skill a plugin brings: `skills/<folder>/SKILL.md` and the files beside it. */
export type PluginSkill = {
  /** From its front matter, else its folder's name. */
  name: string
  description: string
  /** Its folder in the plugin. */
  folder: string
}

/** A plugin of the catalog, as the loader read it (ADR 0007). */
export type Plugin = {
  /** `plugin.json`'s `name`: lowercase kebab-case, part of its tools' names and of the path of its skills. */
  name: string
  /** `plugin.json`'s `displayName`, else its name. */
  displayName: string
  version: string | null
  description: string
  /** The plugin's folder. */
  root: string
  /** `plugin.json`'s `icon`, an image file in the plugin, and its media type; null without one. */
  icon: { file: string; type: string } | null
  servers: PluginServer[]
  skills: PluginSkill[]
}

/** A plugin the loader won't load, e.g. one with a stdio server; the message says why. */
export class PluginRefusedError extends Error {}

/** The media types of the images a plugin's icon may be, by extension. */
const iconTypes: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** A plugin name OpenBot can put in tool names and paths. */
const pluginName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `plugin.json` fields for what OpenBot doesn't run: they're left out, with a warning. */
const ignoredFields = ['hooks', 'commands', 'agents', 'userConfig', 'lspServers', 'outputStyles', 'workflows', 'channels', 'settings', 'experimental', 'dependencies', 'skills']

/** Default folders and files of the Claude Code format for what OpenBot doesn't run. */
const ignoredPaths = ['hooks/', 'commands/', 'agents/', 'output-styles/', 'workflows/', 'monitors/', 'bin/', '.lsp.json', 'settings.json']

/**
 * Reads the Claude Code plugin folder `root`: `.claude-plugin/plugin.json`, `.mcp.json` (hosted `http` servers only)
 * and `skills/*\/SKILL.md`. What OpenBot doesn't run (hooks, commands, agents, config fields…) is ignored, with a
 * warning; a server that would run on this machine, or isn't hosted over Streamable HTTP, refuses the whole plugin.
 */
export async function loadPlugin(root: string): Promise<{ plugin: Plugin; warnings: string[] }> {
  root = resolve(root)
  const warnings: string[] = []
  const manifest = await readJson(root, '.claude-plugin/plugin.json')
  if (!isObject(manifest)) throw new PluginRefusedError('.claude-plugin/plugin.json must hold an object')
  const { name } = manifest
  if (typeof name !== 'string' || !pluginName.test(name)) throw new PluginRefusedError(`plugin.json's name must be lowercase kebab-case, not ${JSON.stringify(name)}`)
  // Servers are read from .mcp.json only; one declared here can't be checked, so it refuses the plugin rather than be dropped.
  if ('mcpServers' in manifest) throw new PluginRefusedError("plugin.json declares mcpServers; declare servers in .mcp.json")
  for (const field of ignoredFields) if (field in manifest) warnings.push(`ignored ${field} in plugin.json`)
  for (const path of ignoredPaths) if (existsSync(join(root, path))) warnings.push(`ignored ${path}`)

  let icon: Plugin['icon'] = null
  if (typeof manifest.icon === 'string') {
    const file = resolveInside(root, manifest.icon)
    const type = file && iconTypes[extname(file).toLowerCase()]
    if (file && type && existsSync(file)) icon = { file, type }
    else warnings.push(`no svg, png, jpeg or webp icon at ${manifest.icon}`)
  }

  return {
    plugin: {
      name,
      displayName: text(manifest.displayName) || name,
      version: text(manifest.version) || null,
      description: text(manifest.description),
      root,
      icon,
      servers: await readServers(root),
      skills: await readSkills(root, warnings),
    },
    warnings,
  }
}

/**
 * Every plugin of the catalog folder `catalog`, one per subfolder, by name; none when there is no such folder. A plugin
 * the loader refuses, or one named like an earlier one, is left out; `problems` says why, beside each plugin's warnings.
 */
export async function loadCatalog(catalog: string): Promise<{ plugins: Plugin[]; problems: string[] }> {
  const plugins: Plugin[] = []
  const problems: string[] = []
  const entries = await readdir(catalog, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    problems.push(`no catalog at ${catalog}`)
    return []
  })
  for (const folder of entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort()) {
    try {
      const { plugin, warnings } = await loadPlugin(join(catalog, folder))
      problems.push(...warnings.map((warning) => `${plugin.name}: ${warning}`))
      if (plugins.some((other) => other.name === plugin.name)) problems.push(`${folder}: refused, another plugin is named ${plugin.name}`)
      else plugins.push(plugin)
    } catch (error) {
      if (!(error instanceof PluginRefusedError)) throw error
      problems.push(`${folder}: refused, ${error.message}`)
    }
  }
  return { plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)), problems }
}

/** `.mcp.json`'s servers, either under `mcpServers` or as the whole file; none without the file. */
async function readServers(root: string): Promise<PluginServer[]> {
  if (!existsSync(join(root, '.mcp.json'))) return []
  const config = await readJson(root, '.mcp.json')
  const servers = isObject(config) && isObject(config.mcpServers) ? config.mcpServers : config
  if (!isObject(servers)) throw new PluginRefusedError('.mcp.json must hold an object of servers')
  return Object.entries(servers).map(([name, server]) => {
    if (!isObject(server)) throw new PluginRefusedError(`server ${name} must be an object`)
    // A server with a command, or without a type, is a stdio server: a process on this machine.
    const type = server.type ?? (server.command === undefined ? undefined : 'stdio')
    if (type !== 'http') throw new PluginRefusedError(`server ${name} is ${type ?? 'of no type'}; only hosted http servers are allowed`)
    const url = typeof server.url === 'string' ? server.url.replaceAll('${CLAUDE_PLUGIN_ROOT}', root) : undefined
    if (!url || !/^https?:$/.test(URL.parse(url)?.protocol ?? '')) throw new PluginRefusedError(`server ${name} needs an http(s) url`)
    return { name, url }
  })
}

/** The skills in `skills/`, by folder; a folder without a readable `SKILL.md` is skipped with a warning. */
async function readSkills(root: string, warnings: string[]): Promise<PluginSkill[]> {
  const skillsFolder = join(root, 'skills')
  if (!existsSync(skillsFolder)) return []
  const skills: PluginSkill[] = []
  for (const entry of (await readdir(skillsFolder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const folder = join(skillsFolder, entry.name)
    const file = join(folder, 'SKILL.md')
    const frontMatter = existsSync(file) ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(await readFile(file, 'utf8'))?.[1] : undefined
    let fields: unknown
    try {
      fields = frontMatter === undefined ? undefined : parseYaml(frontMatter)
    } catch {}
    if (!isObject(fields) || !text(fields.description)) {
      warnings.push(`skipped skills/${entry.name}: SKILL.md needs front matter with a description`)
      continue
    }
    skills.push({ name: text(fields.name) || entry.name, description: text(fields.description), folder })
  }
  return skills
}

/** The JSON file at `path` in `root`. */
async function readJson(root: string, path: string): Promise<unknown> {
  let content: string
  try {
    content = await readFile(join(root, path), 'utf8')
  } catch (error) {
    throw new PluginRefusedError(`can't read ${path}: ${(error as Error).message}`)
  }
  try {
    return JSON.parse(content)
  } catch {
    throw new PluginRefusedError(`${path} isn't valid JSON`)
  }
}

/** `path` resolved in `root`, or undefined when it leads out of it. */
function resolveInside(root: string, path: string): string | undefined {
  const file = resolve(root, path)
  return file.startsWith(root + sep) ? file : undefined
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
