import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SignInStep } from '@openbot/api-contract'
import { systemCredentials } from '@openbot/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'
import { closePluginFixtures, connectAccount, type FixturePlugin, hostedPlugin, privateOrigin, writeCatalog } from './testing/plugins.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await closePluginFixtures()
  vi.restoreAllMocks()
})

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
  it('lists the bundled plugins, among them Notion, Linear, ClickUp and Exa, each hosted over https and not connected', async () => {
    const server = await start()

    const plugins = await server.client.plugins.list()

    expect(plugins.map(({ name, displayName, status, servers }) => ({ name, displayName, status, servers }))).toEqual(
      expect.arrayContaining([
        { name: 'clickup', displayName: 'ClickUp', status: 'not_connected', servers: [{ name: 'clickup', url: 'https://mcp.clickup.com/mcp' }] },
        { name: 'exa', displayName: 'Exa', status: 'not_connected', servers: [{ name: 'exa', url: 'https://mcp.exa.ai/mcp' }] },
        { name: 'linear', displayName: 'Linear', status: 'not_connected', servers: [{ name: 'linear', url: 'https://mcp.linear.app/mcp' }] },
        { name: 'notion', displayName: 'Notion', status: 'not_connected', servers: [{ name: 'notion', url: 'https://mcp.notion.com/mcp' }] },
      ]),
    )
    for (const plugin of plugins) {
      expect(plugin.status).toBe('not_connected')
      expect(plugin.servers).toEqual([{ name: plugin.name, url: expect.stringMatching(/^https:\/\//) }])
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
      accounts: [],
      grantedTo: [],
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

describe('plugin accounts', () => {
  it('connect through the URL the owner pastes when the instance is on a private network over plain HTTP', async () => {
    const { fake, plugin } = await hostedPlugin()
    const server = await start(await writeCatalog({ notes: plugin }))

    const steps = await connectAccount(server, fake)

    expect(steps.map((step) => step.type)).toEqual(['started', 'auth_url', 'prompt', 'connected'])
    expect(steps[2]).toMatchObject({ kind: 'manual_code' })
    expect(fake.clients).toEqual([
      { clientId: 'client-1', redirectUris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)], applicationType: 'native', clientName: 'OpenBot' },
    ])
    expect(await server.client.plugins.get({ name: 'notes' })).toMatchObject({
      status: 'connected',
      accounts: [{ slug: 'account1', displayName: 'Account 1', connectedAt: expect.any(Number) }],
    })
  })

  it("connect through the instance's callback route when it is opened on localhost or over https", async () => {
    const { fake, plugin } = await hostedPlugin()
    const server = await start(await writeCatalog({ notes: plugin }))

    for (const origin of ['http://localhost:3000', 'https://openbot.example.com']) {
      const steps = await connectAccount(server, fake, { origin })
      expect(steps.map((step) => step.type)).toEqual(['started', 'auth_url', 'connected'])
    }

    expect(fake.clients.map(({ redirectUris, applicationType }) => ({ redirectUris, applicationType }))).toEqual([
      { redirectUris: ['http://localhost:3000/api/plugins/oauth/callback'], applicationType: 'native' },
      { redirectUris: ['https://openbot.example.com/api/plugins/oauth/callback'], applicationType: 'web' },
    ])
    expect((await server.client.plugins.get({ name: 'notes' })).accounts.map((account) => account.slug)).toEqual(['account1', 'account2'])
  })

  it('are several per plugin, each with a slug never given again after a disconnect, kept across a restart', async () => {
    const { fake, plugin } = await hostedPlugin()
    const catalog = await writeCatalog({ notes: plugin })
    const server = await start(catalog)
    await connectAccount(server, fake, { user: 'work' })
    await connectAccount(server, fake, { user: 'home' })

    await server.client.plugins.disconnectAccount({ name: 'notes', account: 'account2' })
    await connectAccount(server, fake, { user: 'side' })

    const slugs = async (on: TestServer) => (await on.client.plugins.get({ name: 'notes' })).accounts.map(({ slug, displayName }) => ({ slug, displayName }))
    const expected = [
      { slug: 'account1', displayName: 'Account 1' },
      { slug: 'account3', displayName: 'Account 3' },
    ]
    expect(await slugs(server)).toEqual(expected)
    const restarted = await restartTestServer(servers.pop()!, { catalog })
    servers.push(restarted)
    expect(await slugs(restarted)).toEqual(expected)
    expect((await restarted.client.plugins.list()).find((entry) => entry.name === 'notes')).toMatchObject({ status: 'connected', accounts: expected.map((account) => expect.objectContaining(account)) })
  })

  it('get different slugs when two sign-ins finish together', async () => {
    const { fake, plugin } = await hostedPlugin()
    const server = await start(await writeCatalog({ notes: plugin }))

    await Promise.all([connectAccount(server, fake, { user: 'work' }), connectAccount(server, fake, { user: 'home' })])

    expect((await server.client.plugins.get({ name: 'notes' })).accounts.map((account) => account.slug).sort()).toEqual(['account1', 'account2'])
  })

  it('can be renamed, and a blank name or an unknown account is refused', async () => {
    const { fake, plugin } = await hostedPlugin()
    const server = await start(await writeCatalog({ notes: plugin }))
    await connectAccount(server, fake)

    expect(await server.client.plugins.renameAccount({ name: 'notes', account: 'account1', displayName: '  Work  ' })).toMatchObject({ slug: 'account1', displayName: 'Work' })
    expect((await server.client.plugins.get({ name: 'notes' })).accounts).toMatchObject([{ slug: 'account1', displayName: 'Work' }])
    await expect(server.client.plugins.renameAccount({ name: 'notes', account: 'account1', displayName: ' ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(server.client.plugins.renameAccount({ name: 'notes', account: 'account9', displayName: 'Home' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.plugins.renameAccount({ name: 'nope', account: 'account1', displayName: 'Home' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('keep their tokens encrypted until disconnected, which deletes them and leaves the plugin not connected', async () => {
    const { fake, plugin } = await hostedPlugin()
    const server = await start(await writeCatalog({ notes: plugin }))
    await connectAccount(server, fake)

    const rows = await server.db.select().from(systemCredentials)
    expect(rows.map((row) => row.key)).toEqual(['plugin:notes:account1'])
    expect(fake.issuedTokens).toHaveLength(2)
    for (const token of fake.issuedTokens) expect(JSON.stringify(rows)).not.toContain(token)

    await server.client.plugins.disconnectAccount({ name: 'notes', account: 'account1' })

    expect(await server.db.select().from(systemCredentials)).toEqual([])
    expect(await server.client.plugins.get({ name: 'notes' })).toMatchObject({ status: 'not_connected', accounts: [] })
    await expect(server.client.plugins.disconnectAccount({ name: 'notes', account: 'account1' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("aren't connected when the owner denies the sign-in", async () => {
    const { fake, plugin } = await hostedPlugin()
    const server = await start(await writeCatalog({ notes: plugin }))

    const steps: SignInStep[] = []
    for await (const step of await server.client.plugins.connect({ name: 'notes', origin: 'http://localhost:3000' })) {
      steps.push(step)
      if (step.type === 'auth_url') {
        const endsOn = new URL(await fake.authorize(step.url, { deny: true }))
        expect((await server.fetch(`${endsOn.pathname}${endsOn.search}`, { redirect: 'manual' })).status).toBe(303)
      }
    }

    expect(steps.at(-1)).toEqual({ type: 'failed', message: expect.stringContaining("Notes didn't allow the sign-in: access_denied") })
    expect((await server.client.plugins.get({ name: 'notes' })).status).toBe('not_connected')
  })

  it("refuse a pasted URL that isn't where the sign-in ended, and still take the right one", async () => {
    const { fake, plugin } = await hostedPlugin()
    const server = await start(await writeCatalog({ notes: plugin }))

    const steps: SignInStep[] = []
    let signInId = ''
    let endsOn = ''
    for await (const step of await server.client.plugins.connect({ name: 'notes', origin: privateOrigin })) {
      steps.push(step)
      if (step.type === 'started') signInId = step.signInId
      if (step.type === 'auth_url') endsOn = await fake.authorize(step.url)
      if (step.type !== 'prompt') continue
      const answer = (value: string) => server.client.plugins.answer({ signInId, promptId: step.promptId, value })
      const forged = new URL(endsOn)
      forged.searchParams.set('state', 'another-sign-in')
      await expect(answer(forged.href)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(answer('not a url')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await answer(endsOn)
    }

    expect(steps.at(-1)).toEqual({ type: 'connected' })
  })

  it('are not connected by a sign-in the owner cancelled, whose callback goes back to the catalog', async () => {
    const { fake, plugin } = await hostedPlugin()
    const server = await start(await writeCatalog({ notes: plugin }))

    let endsOn: URL | undefined
    for await (const step of await server.client.plugins.connect({ name: 'notes', origin: 'http://localhost:3000' })) {
      if (step.type !== 'auth_url') continue
      endsOn = new URL(await fake.authorize(step.url))
      break
    }
    const back = await server.fetch(`${endsOn!.pathname}${endsOn!.search}`, { redirect: 'manual' })

    expect(back.headers.get('location')).toBe('/settings/plugins')
    expect((await server.client.plugins.get({ name: 'notes' })).status).toBe('not_connected')
  })

  it('are refused for a plugin of skills only', async () => {
    const guide: FixturePlugin = { '.claude-plugin/plugin.json': { name: 'guide', description: 'Just advice' } }
    const server = await start(await writeCatalog({ guide }))

    const steps = await server.client.plugins.connect({ name: 'guide', origin: privateOrigin })
    await expect(steps.next()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
