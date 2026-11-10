import type { FakeMcpTool, FakeRegisteredClient } from '@openbot/agent/testing'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo } from '@openbot/api-contract'
import { systemCredentials } from '@openbot/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'
import { closePluginFixtures, connectAccount, hostedPlugin, writeCatalog } from './testing/plugins.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await closePluginFixtures()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** The client the owner registered in advance with the server's authorization server, as with Google's. */
const registered: FakeRegisteredClient = { clientId: 'owner-client.apps.test', clientSecret: 'owner-secret', redirectUris: ['http://127.0.0.1:8976/callback'] }

/** The server's `oauth` in `.mcp.json`, as the catalog's Google plugins have it, its ID and secret from the environment. */
const oauth = {
  clientId: '${TEST_OAUTH_CLIENT_ID}',
  clientSecret: '${TEST_OAUTH_CLIENT_SECRET}',
  scopes: ['notes.read', 'notes.write'],
  authorizationParams: { access_type: 'offline', prompt: 'consent' },
}

const searchPages: FakeMcpTool = {
  name: 'search_pages',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  call: ({ query }) => `Found 2 pages about ${String(query)}.`,
}

async function start() {
  vi.stubEnv('TEST_OAUTH_CLIENT_ID', registered.clientId)
  vi.stubEnv('TEST_OAUTH_CLIENT_SECRET', registered.clientSecret)
  const { fake, plugin } = await hostedPlugin('notes', [searchPages], { registered, oauth })
  const server = await createTestServer({ catalog: await writeCatalog({ notes: plugin }) })
  servers.push(server)
  return { server, fake }
}

async function send(server: TestServer, bot: BotInfo, text: string) {
  await server.client.chats.send({ chatId: bot.chatId, text })
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

describe('a plugin whose OAuth client is registered in advance', () => {
  it("signs in as that client, with the catalog's scopes and authorization parameters, registering none", async () => {
    const { server, fake } = await start()

    const steps = await connectAccount(server, fake)

    expect(steps.map((step) => step.type)).toEqual(['started', 'auth_url', 'prompt', 'connected'])
    expect(fake.clients).toHaveLength(1)
    const [request] = fake.authorizationRequests
    expect(Object.fromEntries(request!)).toMatchObject({
      client_id: registered.clientId,
      scope: 'notes.read notes.write',
      access_type: 'offline',
      prompt: 'consent',
    })
    expect(await server.client.plugins.get({ name: 'notes' })).toMatchObject({ status: 'connected', servers: [{ name: 'notes', url: fake.url }] })
  })

  it('keeps its secret out of the API and the stored credentials', async () => {
    const { server, fake } = await start()
    await connectAccount(server, fake)

    expect(JSON.stringify(await server.client.plugins.list())).not.toContain(registered.clientSecret)
    expect(JSON.stringify(await server.client.plugins.get({ name: 'notes' }))).not.toContain(registered.clientSecret)
    const rows = await server.db.select().from(systemCredentials)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(registered.clientSecret)
  })

  it("is called by a granted bot, and refreshes an expired token as that client", async () => {
    const { server, fake } = await start()
    await server.connectProvider()
    await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
    await connectAccount(server, fake)
    const rex = await server.client.bots.create({ name: 'Rex', title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    const search = (query: string) =>
      server.providers.script(callsTools(['tool_search', { query: 'search notes' }]), callsTools(['mcp__notes_account1__search_pages', { query }]), endsSilently())

    search('trip')
    await send(server, rex, 'Find my trip notes')
    fake.expireAccessTokens()
    search('budget')
    await send(server, rex, 'And my budget notes')

    expect(fake.calls.map((call) => call.args.query)).toEqual(['trip', 'budget'])
    expect((await server.client.plugins.get({ name: 'notes' })).accounts[0]).toMatchObject({ needsReconnect: false })
  })

  it("is refused, with a warning naming what to set, when the environment doesn't set its client", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { plugin } = await hostedPlugin('notes', [], { registered, oauth })
    const server = await createTestServer({ catalog: await writeCatalog({ notes: plugin }) })
    servers.push(server)

    expect(await server.client.plugins.list()).toEqual([])
    expect(warn.mock.calls.map((call) => call.join(' '))).toContainEqual(
      expect.stringMatching(/notes: refused, server notes needs TEST_OAUTH_CLIENT_ID and TEST_OAUTH_CLIENT_SECRET set/),
    )
  })
})
