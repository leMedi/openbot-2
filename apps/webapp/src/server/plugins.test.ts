import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
const folders: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

/** A plugin folder's files, by path from its root; objects are written as JSON. */
type FixturePlugin = Record<string, string | object>

/** Writes a catalog of `plugins`, by folder name, into a temporary folder; returns it. */
async function writeCatalog(plugins: Record<string, FixturePlugin>, into?: string): Promise<string> {
  const catalog = into ?? (await mkdtemp(join(tmpdir(), 'openbot-catalog-')))
  if (!into) folders.push(catalog)
  await rm(catalog, { recursive: true, force: true })
  for (const [folder, files] of Object.entries(plugins)) {
    for (const [path, content] of Object.entries(files)) {
      const file = join(catalog, folder, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
    }
  }
  return catalog
}

const skill = (name: string, description: string, body = 'Use it well.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

/** A hosted plugin with one skill, as the catalog's are. */
const notes: FixturePlugin = {
  '.claude-plugin/plugin.json': { name: 'notes', displayName: 'Notes', version: '1.0.0', description: 'Your notes workspace', icon: './logo.svg' },
  '.mcp.json': { mcpServers: { notes: { type: 'http', url: 'https://mcp.notes.test/mcp' } } },
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'skills/notes-search/SKILL.md': skill('notes-search', 'How to search notes'),
  'skills/notes-search/reference/filters.md': 'Filter by tag.',
}

async function start(catalog?: string) {
  const server = await createTestServer(catalog ? { catalog } : {})
  servers.push(server)
  return server
}

describe('the plugin catalog', () => {
  it('lists the bundled plugins, Notion, Linear, ClickUp and Exa, each hosted and not connected', async () => {
    const server = await start()

    const plugins = await server.client.plugins.list()

    expect(plugins.map(({ name, displayName, status, servers }) => ({ name, displayName, status, servers }))).toEqual([
      { name: 'clickup', displayName: 'ClickUp', status: 'not_connected', servers: [{ name: 'clickup', url: 'https://mcp.clickup.com/mcp' }] },
      { name: 'exa', displayName: 'Exa', status: 'not_connected', servers: [{ name: 'exa', url: 'https://mcp.exa.ai/mcp' }] },
      { name: 'linear', displayName: 'Linear', status: 'not_connected', servers: [{ name: 'linear', url: 'https://mcp.linear.app/mcp' }] },
      { name: 'notion', displayName: 'Notion', status: 'not_connected', servers: [{ name: 'notion', url: 'https://mcp.notion.com/mcp' }] },
    ])
    for (const plugin of plugins) {
      expect(plugin.description).not.toBe('')
      expect(plugin.icon).toBe(`/plugins/${plugin.name}/icon`)
    }
  })

  it("shows one plugin's details with its skills, and answers an unknown one as not found", async () => {
    const server = await start(await writeCatalog({ notes }))

    expect(await server.client.plugins.get({ name: 'notes' })).toEqual({
      name: 'notes',
      displayName: 'Notes',
      version: '1.0.0',
      description: 'Your notes workspace',
      icon: '/plugins/notes/icon',
      status: 'not_connected',
      servers: [{ name: 'notes', url: 'https://mcp.notes.test/mcp' }],
      skills: [{ name: 'notes-search', description: 'How to search notes' }],
    })
    await expect(server.client.plugins.get({ name: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("serves a plugin's icon, and none for a plugin without one", async () => {
    const { 'logo.svg': _, ...plain } = notes
    const server = await start(
      await writeCatalog({ notes, plain: { ...plain, '.claude-plugin/plugin.json': { name: 'plain', description: 'No icon' } } }),
    )

    const icon = await server.fetch('/api/plugins/notes/icon')
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toBe('image/svg+xml')
    expect(icon.headers.get('content-security-policy')).toBe('sandbox')
    expect(await icon.text()).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect((await server.client.plugins.get({ name: 'plain' })).icon).toBeNull()
    expect((await server.fetch('/api/plugins/plain/icon')).status).toBe(404)
  })

  it('refuses a plugin with a stdio server, or any server not hosted over http, and loads the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const local: FixturePlugin = {
      '.claude-plugin/plugin.json': { name: 'local', description: 'Runs on your machine' },
      '.mcp.json': { mcpServers: { local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } } },
    }
    const stream: FixturePlugin = {
      '.claude-plugin/plugin.json': { name: 'stream', description: 'Old transport' },
      '.mcp.json': { mcpServers: { stream: { type: 'sse', url: 'https://sse.test/sse' } } },
    }
    const inline: FixturePlugin = {
      '.claude-plugin/plugin.json': { name: 'inline', description: 'Servers in its manifest', mcpServers: { inline: { command: 'node' } } },
    }
    const server = await start(await writeCatalog({ notes, local, stream, inline }))

    expect((await server.client.plugins.list()).map((plugin) => plugin.name)).toEqual(['notes'])
    const warnings = warn.mock.calls.map((call) => call.join(' '))
    expect(warnings).toContainEqual(expect.stringMatching(/local.*refused.*stdio/))
    expect(warnings).toContainEqual(expect.stringMatching(/stream.*refused.*sse/))
    expect(warnings).toContainEqual(expect.stringMatching(/inline.*refused.*mcpServers/))
  })

  it('ignores hooks, commands, agents and config fields with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const busy: FixturePlugin = {
      ...notes,
      '.claude-plugin/plugin.json': {
        name: 'busy',
        description: 'Brings more than we take',
        userConfig: { token: { type: 'string', title: 'Token', description: 'A token' } },
        agents: ['./agents/helper.md'],
      },
      'hooks/hooks.json': { hooks: {} },
      'commands/go.md': 'Go.',
      'agents/helper.md': 'Help.',
    }
    const server = await start(await writeCatalog({ busy }))

    expect(await server.client.plugins.get({ name: 'busy' })).toMatchObject({ name: 'busy', servers: [{ name: 'notes' }] })
    const warnings = warn.mock.calls.map((call) => call.join(' '))
    for (const ignored of ['userConfig', 'agents', 'hooks/', 'commands/', 'agents/']) {
      expect(warnings).toContainEqual(expect.stringContaining(`busy: ignored ${ignored}`))
    }
  })

  it("expands ${CLAUDE_PLUGIN_ROOT} in a server's url, and reads a bare server map", async () => {
    const rooted: FixturePlugin = {
      '.claude-plugin/plugin.json': { name: 'rooted', description: 'Odd but allowed' },
      '.mcp.json': { rooted: { type: 'http', url: 'https://mcp.rooted.test/mcp?from=${CLAUDE_PLUGIN_ROOT}' } },
    }
    const catalog = await writeCatalog({ rooted })
    const server = await start(catalog)

    expect((await server.client.plugins.get({ name: 'rooted' })).servers).toEqual([
      { name: 'rooted', url: `https://mcp.rooted.test/mcp?from=${join(catalog, 'rooted')}` },
    ])
  })

  it('is empty, rather than the server failing to start, without a catalog folder', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = await start(join(await writeCatalog({}), 'missing'))

    expect(await server.client.plugins.list()).toEqual([])
    expect(warn.mock.calls.map((call) => call.join(' '))).toContainEqual(expect.stringContaining('no catalog at'))
  })

  it('may be skills only, without a server', async () => {
    const guide: FixturePlugin = {
      '.claude-plugin/plugin.json': { name: 'guide', description: 'Just advice' },
      'skills/writing/SKILL.md': skill('writing', 'How to write'),
    }
    const server = await start(await writeCatalog({ guide }))

    expect(await server.client.plugins.get({ name: 'guide' })).toMatchObject({ servers: [], skills: [{ name: 'writing' }] })
  })
})

describe("plugins' skills", () => {
  it("are copied read-only into the bots' home on boot", async () => {
    const server = await start(await writeCatalog({ notes }))
    const skills = join(server.home, 'plugins', 'notes', 'skills')

    expect(await readFile(join(skills, 'notes-search', 'SKILL.md'), 'utf8')).toBe(skill('notes-search', 'How to search notes'))
    expect(await readFile(join(skills, 'notes-search', 'reference', 'filters.md'), 'utf8')).toBe('Filter by tag.')
    expect((await stat(join(skills, 'notes-search', 'SKILL.md'))).mode & 0o777).toBe(0o444)
    expect((await stat(join(skills, 'notes-search'))).mode & 0o777).toBe(0o755)
  })

  it("are refreshed when a release changes them, and a removed plugin's are gone", async () => {
    const catalog = await writeCatalog({ notes, old: { '.claude-plugin/plugin.json': { name: 'old', description: 'Going away' }, 'skills/old/SKILL.md': skill('old', 'Old') } })
    const server = await start(catalog)
    const plugins = join(server.home, 'plugins')
    expect(await readdir(plugins)).toEqual(expect.arrayContaining(['notes', 'old']))

    const { 'skills/notes-search/reference/filters.md': _, ...unchanged } = notes
    await writeCatalog(
      {
        notes: {
          ...unchanged,
          'skills/notes-search/SKILL.md': skill('notes-search', 'How to search notes', 'Search titles first.'),
          'skills/notes-write/SKILL.md': skill('notes-write', 'How to write notes'),
        },
      },
      catalog,
    )
    servers.push(await restartTestServer(servers.pop()!, { catalog }))

    expect(await readdir(plugins)).toEqual(['notes'])
    expect(await readdir(join(plugins, 'notes', 'skills'))).toEqual(['notes-search', 'notes-write'])
    expect(await readFile(join(plugins, 'notes', 'skills', 'notes-search', 'SKILL.md'), 'utf8')).toContain('Search titles first.')
    expect(await readdir(join(plugins, 'notes', 'skills', 'notes-search'))).toEqual(['SKILL.md'])
  })
})
