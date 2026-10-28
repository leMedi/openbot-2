import type { FakeMcpTool } from '@openbot/agent/testing'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'
import { closePluginFixtures, connectAccount, hostedPlugin, writeCatalog } from './testing/plugins.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await closePluginFixtures()
})

const newBot = (name: string): NewBot => ({ name, title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })

/** The notes server's one tool: it finds pages by query, as the account it is called as. */
const searchPages: FakeMcpTool = {
  name: 'search_pages',
  description: 'Search the pages of the workspace',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  call: ({ query }) => `Found 2 pages about ${String(query)}.`,
}

/**
 * A server whose catalog has the hosted plugin Notes, served by a fake MCP server offering `tools`; one account
 * connected as `owner`.
 */
async function start(tools: FakeMcpTool[] = [searchPages]) {
  const { fake, plugin } = await hostedPlugin('notes', tools)
  const server = await createTestServer({ catalog: await writeCatalog({ notes: plugin }) })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  await connectAccount(server, fake)
  return { server, fake }
}

async function send(server: TestServer, bot: BotInfo, text: string) {
  await server.client.chats.send({ chatId: bot.chatId, text })
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** What the tool results of the run told the model, from request `request`. */
const toolResults = (server: TestServer, request: number) =>
  server.providers.requests[request]!.messages.flatMap((message) =>
    message.role === 'toolResult' ? [{ tool: message.toolName, isError: message.isError, text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join('') }] : [],
  )

const notesSearch = 'mcp__notes_account1__search_pages'

describe('plugin accounts granted to bots', () => {
  it("reach a granted bot as deferred tools it finds with tool_search and calls on the account's server", async () => {
    const { server, fake } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    server.providers.script(callsTools(['tool_search', { query: 'search notes pages' }]), callsTools([notesSearch, { query: 'trip' }]), endsSilently())

    await send(server, rex, 'Find my trip notes')

    const [first, second] = server.providers.requests
    expect(first!.tools).not.toContain(notesSearch)
    expect(second!.tools).toContain(notesSearch)
    expect(fake.calls).toEqual([{ tool: 'search_pages', args: { query: 'trip' }, user: 'owner' }])
    expect(toolResults(server, 2).at(-1)).toEqual({ tool: notesSearch, isError: false, text: 'Found 2 pages about trip.' })
  })

  it("aren't found or called by a bot without a grant", async () => {
    const { server, fake } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    server.providers.scriptFor('Ada', callsTools(['tool_search', { query: 'search notes pages' }]), callsTools([notesSearch, { query: 'trip' }]), endsSilently())

    await send(server, ada, 'Find my trip notes')

    expect(server.providers.requests.every((request) => !request.tools.includes(notesSearch))).toBe(true)
    expect(fake.calls).toEqual([])
    expect(toolResults(server, 2).at(-1)).toMatchObject({ tool: notesSearch, isError: true })
  })

  it('give each account of a plugin its own tools, named by its slug and described with its name', async () => {
    const { server, fake } = await start()
    await connectAccount(server, fake, { user: 'work' })
    await server.client.plugins.renameAccount({ name: 'notes', account: 'account2', displayName: 'Work' })
    const rex = await server.client.bots.create(newBot('Rex'))
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    await server.client.plugins.grant({ name: 'notes', account: 'account2', botId: rex.id })
    const workSearch = 'mcp__notes_account2__search_pages'
    server.providers.script(
      callsTools(['tool_search', { query: 'search notes pages' }]),
      callsTools([workSearch, { query: 'roadmap' }], [notesSearch, { query: 'trip' }]),
      endsSilently(),
    )

    await send(server, rex, 'Find my roadmap at work and my trip notes')

    expect(server.providers.requests[1]!.tools).toEqual(expect.arrayContaining([notesSearch, workSearch]))
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        { tool: 'search_pages', args: { query: 'roadmap' }, user: 'work' },
        { tool: 'search_pages', args: { query: 'trip' }, user: 'owner' },
      ]),
    )
    const found = toolResults(server, 1).find((result) => result.tool === 'tool_search')!.text
    expect(found).toContain('Notes (Work)')
    expect(found).toContain('Notes (Account 1)')
  })

  it('are listed with the bots granted each account, and taken back when the bot is deleted', async () => {
    const { server } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))

    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    expect(await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: ada.id })).toMatchObject({ grantedTo: [rex.id, ada.id] })
    await server.client.bots.delete({ botId: rex.id })

    expect((await server.client.plugins.get({ name: 'notes' })).accounts).toMatchObject([{ slug: 'account1', grantedTo: [ada.id] }])
    expect((await server.client.plugins.list()).find((plugin) => plugin.name === 'notes')!.accounts[0]!.grantedTo).toEqual([ada.id])
  })

  it('refuse an account, plugin or bot that doesn\'t exist', async () => {
    const { server } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))

    await expect(server.client.plugins.grant({ name: 'notes', account: 'account9', botId: rex.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.plugins.grant({ name: 'nope', account: 'account1', botId: rex.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.plugins.grant({ name: 'notes', account: 'account1', botId: 'nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("are revoked from the bot's next call, and a call in flight finishes", async () => {
    let release!: () => void
    const { server, fake: slowFake } = await start([
      { ...searchPages, call: async ({ query }) => (await new Promise<void>((resolve) => (release = resolve)), `Found 2 pages about ${String(query)}.`) },
    ])
    const rex = await server.client.bots.create(newBot('Rex'))
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    server.providers.script(
      callsTools(['tool_search', { query: 'search notes pages' }]),
      callsTools([notesSearch, { query: 'trip' }]),
      callsTools([notesSearch, { query: 'budget' }]),
      endsSilently(),
    )
    const sent = send(server, rex, 'Find my trip and budget notes')

    // Revoked while the first call is on the server.
    await expect.poll(() => typeof release).toBe('function')
    await server.client.plugins.revoke({ name: 'notes', account: 'account1', botId: rex.id })
    release()
    await sent

    expect(slowFake.calls).toEqual([{ tool: 'search_pages', args: { query: 'trip' }, user: 'owner' }])
    expect(toolResults(server, 2).at(-1)).toEqual({ tool: notesSearch, isError: false, text: 'Found 2 pages about trip.' })
    expect(toolResults(server, 3).at(-1)).toMatchObject({ tool: notesSearch, isError: true, text: expect.stringContaining("isn't available to you any more") })
    expect((await server.client.plugins.get({ name: 'notes' })).accounts[0]!.grantedTo).toEqual([])
  })

  it("are gone from the bot's next call once the account is disconnected, and the bot is told in its history", async () => {
    const { server, fake } = await start()
    await server.client.plugins.renameAccount({ name: 'notes', account: 'account1', displayName: 'Work' })
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    server.providers.script(callsTools(['tool_search', { query: 'search notes pages' }]), callsTools([notesSearch, { query: 'trip' }]), endsSilently())
    await send(server, rex, 'Find my trip notes')

    await server.client.plugins.disconnectAccount({ name: 'notes', account: 'account1' })
    server.providers.script(callsTools([notesSearch, { query: 'budget' }]), endsSilently())
    await send(server, rex, 'And my budget notes?')
    server.providers.scriptFor('Ada', endsSilently())
    await send(server, ada, 'Hello')

    expect(fake.calls).toHaveLength(1)
    const next = server.providers.requests[3]!
    expect(next.tools).not.toContain(notesSearch)
    const told = next.messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message.content))
    expect(told.some((text) => text.includes('Notes (Work) was disconnected'))).toBe(true)
    expect(toolResults(server, 4).at(-1)).toMatchObject({ tool: notesSearch, isError: true })
    const adaTold = server.providers.requests.at(-1)!.messages.map((message) => JSON.stringify(message.content))
    expect(adaTold.some((text) => text.includes('disconnected'))).toBe(false)
  })

  it('are reviewed under the mcp surface, each call audited with its server, tool, status and duration', async () => {
    const failing: FakeMcpTool = { name: 'delete_page', description: 'Delete a page', call: () => Promise.reject(new Error('Page is locked')) }
    const { server } = await start([searchPages, failing])
    const rex = await server.client.bots.create(newBot('Rex'))
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    const deletePage = 'mcp__notes_account1__delete_page'
    server.providers.script(
      callsTools(['tool_search', { query: 'notes pages' }]),
      callsTools([notesSearch, { query: 'trip' }]),
      callsTools([deletePage, { id: 'p1' }]),
      endsSilently(),
    )

    await send(server, rex, 'Find my trip notes, then delete the first page')

    expect(await server.client.bots.audit({ botId: rex.id })).toMatchObject([
      { kind: 'action', surface: 'mcp', server: 'notes_account1', tool: notesSearch, input: { query: 'trip' }, outcome: { status: 'ok', durationMs: expect.any(Number) } },
      { kind: 'action', surface: 'mcp', server: 'notes_account1', tool: deletePage, input: { id: 'p1' }, outcome: { status: 'error', durationMs: expect.any(Number) } },
    ])
  })

  it('reconnect on the next call after the server drops their session', async () => {
    let restart = () => {}
    // The server restarts once it has answered the first search.
    const { server, fake } = await start([{ ...searchPages, call: (args, caller) => (restart(), searchPages.call!(args, caller)) }])
    restart = () => {
      restart = () => {}
      fake.dropSessions()
    }
    const rex = await server.client.bots.create(newBot('Rex'))
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: rex.id })
    server.providers.script(
      callsTools(['tool_search', { query: 'search notes pages' }]),
      callsTools([notesSearch, { query: 'trip' }]),
      callsTools([notesSearch, { query: 'budget' }]),
      callsTools([notesSearch, { query: 'roadmap' }]),
      endsSilently(),
    )

    await send(server, rex, 'Find my notes')

    expect(fake.calls.map((call) => call.args.query)).toEqual(['trip', 'roadmap'])
    expect(toolResults(server, 3).at(-1)).toMatchObject({ tool: notesSearch, isError: true })
    expect(toolResults(server, 4).at(-1)).toEqual({ tool: notesSearch, isError: false, text: 'Found 2 pages about roadmap.' })
  })
})
