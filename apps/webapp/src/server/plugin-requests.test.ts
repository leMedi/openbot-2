import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { FakeMcpServer, FakeMcpTool } from '@openbot/agent/testing'
import type { BotInfo, MessageInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'
import { closePluginFixtures, connectAccount, hostedPlugin, writeCatalog } from './testing/plugins.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await closePluginFixtures()
})

const newBot = (name: string): NewBot => ({ name, title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })

const searchPages: FakeMcpTool = {
  name: 'search_pages',
  description: 'Search the pages of the workspace',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  call: ({ query }) => `Found 2 pages about ${String(query)}.`,
}

/**
 * A server whose catalog has Notes (hosted, served by a fake MCP server), Tasks (hosted, never connected) and Style (skills
 * only); Notes has `accounts` accounts connected, as `owner`, `work`…
 */
async function start({ accounts = 1 } = {}) {
  const { fake, plugin: notes } = await hostedPlugin('notes', [searchPages])
  const { plugin: tasks } = await hostedPlugin('tasks')
  tasks['.claude-plugin/plugin.json'] = { name: 'tasks', displayName: 'Tasks', description: 'Your team tasks' }
  const style = {
    '.claude-plugin/plugin.json': { name: 'style', displayName: 'Style', description: 'House writing style' },
    'skills/tone/SKILL.md': '---\nname: tone\ndescription: Write in the house tone\n---\nBe brief.',
  }
  const server = await createTestServer({ catalog: await writeCatalog({ notes, tasks, style }) })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  for (const user of ['owner', 'work'].slice(0, accounts)) await connectAccount(server, fake, { user })
  return { server, fake }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

async function send(server: TestServer, bot: BotInfo, text: string) {
  await server.client.chats.send({ chatId: bot.chatId, text })
  await untilIdle(server, bot)
}

/** What the tool results of the run told the model, from request `request`. */
const toolResults = (server: TestServer, request: number) =>
  server.providers.requests[request]!.messages.flatMap((message) =>
    message.role === 'toolResult' ? [{ tool: message.toolName, isError: message.isError, text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join('') }] : [],
  )

/** What the model read as user input in request `request`. */
const inputs = (server: TestServer, request: number) =>
  server.providers.requests[request]!.messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message.content))

const notesSearch = 'mcp__notes_account1__search_pages'

describe('search_plugins', () => {
  it("lists the catalog with the calling bot's own status for each plugin", async () => {
    const { server } = await start({ accounts: 2 })
    await server.client.plugins.renameAccount({ name: 'notes', account: 'account2', displayName: 'Work' })
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))
    await server.client.plugins.grant({ name: 'notes', account: 'account2', botId: rex.id })
    await server.client.plugins.grantSkills({ name: 'style', botId: ada.id })
    const search = () => server.providers.script(callsTools(['search_plugins', {}]), callsTools(['sendMessage', { text: 'Checked.' }]), endsSilently())

    search()
    await send(server, rex, 'Can you reach my notes?')
    const forRex = toolResults(server, 1).at(-1)!
    search()
    await send(server, ada, 'Can you reach my notes?')
    const forAda = toolResults(server, 4).at(-1)!

    expect(forRex.isError).toBe(false)
    expect(forRex.text).toContain('notes (Notes): Your notes workspace')
    expect(forRex.text).toContain('Granted to you: Work (tools mcp__notes_account2__…)')
    expect(forRex.text).toContain('Connected, not granted to you: Account 1')
    expect(forRex.text).toContain('tasks (Tasks): Your team tasks\n  Not connected')
    expect(forRex.text).toContain('style (Style): House writing style\n  Skills only, not granted to you')
    expect(forAda.text).toContain('Connected, not granted to you: Account 1, Work')
    expect(forAda.text).not.toContain('Granted to you: Work')
    expect(forAda.text).toContain('style (Style): House writing style\n  Skills only, granted to you')
  })

  it('filters the catalog by query', async () => {
    const { server } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    server.providers.script(callsTools(['search_plugins', { query: 'team TASK' }]), callsTools(['search_plugins', { query: 'calendar' }]), endsSilently())

    await send(server, rex, 'Find me a tasks tool')

    expect(toolResults(server, 1).at(-1)!.text).toContain('tasks (Tasks)')
    expect(toolResults(server, 1).at(-1)!.text).not.toContain('notes (Notes)')
    expect(toolResults(server, 2).at(-1)!.text).toContain('No plugin matches "calendar"')
  })

  it('is what the prompt says to check before using the browser for a service', async () => {
    const { server } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    server.providers.script(endsSilently())

    await send(server, rex, 'Hello')

    expect(JSON.stringify(server.providers.requests[0]!.messages)).toContain('check search_plugins before using the browser for a service')
  })
})

const tripNotes = { plugin: 'notes', reason: 'To find your trip notes' }

/** Rex asks for Notes in answer to the owner's message, and its run ends at the card. */
async function requestedByRex(options: { accounts?: number } = {}) {
  const started = await start(options)
  const { server } = started
  const rex = await server.client.bots.create(newBot('Rex'))
  server.providers.script(callsTools(['request_plugin', tripNotes]))
  await send(server, rex, 'Find my trip notes')
  const card = (await server.client.chats.messages({ chatId: rex.chatId })).at(-1)!
  return { ...started, rex, card }
}

/** Rex, woken by the owner's decision, loads the Notes tools and searches with them, then replies. */
const searchesNotes = (server: TestServer, tool = notesSearch) =>
  server.providers.script(
    callsTools(['tool_search', { query: 'search notes pages' }]),
    callsTools([tool, { query: 'trip' }]),
    callsTools(['sendMessage', { text: 'Found them' }]),
    endsSilently(),
  )

/** The card as it is now. */
const cardNow = async (server: TestServer, card: MessageInfo) =>
  (await server.client.chats.messages({ chatId: card.chatId })).find((message) => message.id === card.id)!

describe('request_plugin', () => {
  it("posts one card in the bot's DM, and asking ends the run", async () => {
    const { server, rex, card } = await requestedByRex()

    expect(card).toMatchObject({
      author: 'bot',
      authorName: 'Rex',
      card: { type: 'plugin_request', plugin: 'notes', displayName: 'Notes', reason: 'To find your trip notes', skillsOnly: false, decision: null },
    })
    expect(server.providers.requests).toHaveLength(1)
    const chat = (await server.client.chats.list()).find((entry) => entry.id === rex.chatId)!
    expect(chat.waitingFor).toBe(card.text)
  })

  it('refuses a plugin the catalog lacks, naming those it has', async () => {
    const { server } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    server.providers.script(callsTools(['request_plugin', { plugin: 'calendar', reason: 'To book' }]), callsTools(['sendMessage', { text: 'No' }]), endsSilently())

    await send(server, rex, 'Book a meeting')

    expect(toolResults(server, 1).at(-1)).toMatchObject({ tool: 'request_plugin', isError: true, text: expect.stringContaining('notes, style, tasks') })
    expect((await server.client.chats.messages({ chatId: rex.chatId })).some((message) => message.card)).toBe(false)
  })

  it('connects a new account from the card when nothing is connected, grants it, and wakes the bot, which uses its tools', async () => {
    const { server, fake, rex, card } = await requestedByRex({ accounts: 0 })
    searchesNotes(server)

    await connectAccount(server, fake, { requestId: card.id })
    await expect.poll(() => fake.calls.length).toBe(1)
    await untilIdle(server, rex)

    expect((await cardNow(server, card)).card).toMatchObject({ decision: { outcome: 'granted', account: { slug: 'account1', displayName: 'Account 1' } } })
    expect((await server.client.plugins.get({ name: 'notes' })).accounts).toMatchObject([{ slug: 'account1', grantedTo: [rex.id] }])
    expect(inputs(server, 1).at(-1)).toContain('The owner granted you Notes (Account 1)')
    expect(fake.calls).toEqual([{ tool: 'search_pages', args: { query: 'trip' }, user: 'owner' }])
    const chat = (await server.client.chats.list()).find((entry) => entry.id === rex.chatId)!
    expect(chat.waitingFor).toBeNull()
  })

  it('grants the account the owner picks when accounts are connected, and only that one', async () => {
    const { server, fake, rex, card } = await requestedByRex({ accounts: 2 })
    await server.client.plugins.renameAccount({ name: 'notes', account: 'account2', displayName: 'Work' })
    const workSearch = 'mcp__notes_account2__search_pages'
    searchesNotes(server, workSearch)

    const decided = await server.client.chats.decidePluginRequest({ messageId: card.id, decision: { outcome: 'granted', account: 'account2' } })
    await untilIdle(server, rex)

    expect(decided.card).toMatchObject({ decision: { outcome: 'granted', account: { slug: 'account2', displayName: 'Work' } } })
    expect((await server.client.plugins.get({ name: 'notes' })).accounts).toMatchObject([{ slug: 'account1', grantedTo: [] }, { slug: 'account2', grantedTo: [rex.id] }])
    expect(inputs(server, 1).at(-1)).toContain('The owner granted you Notes (Work)')
    expect(inputs(server, 1).at(-1)).toContain('mcp__notes_account2__')
    expect(server.providers.requests[2]!.tools).toContain(workSearch)
    expect(server.providers.requests[2]!.tools).not.toContain(notesSearch)
    expect(fake.calls).toEqual([{ tool: 'search_pages', args: { query: 'trip' }, user: 'work' }])
  })

  it('connects another account from the card when accounts are connected, and grants the new one', async () => {
    const { server, fake, rex, card } = await requestedByRex({ accounts: 1 })
    searchesNotes(server, 'mcp__notes_account2__search_pages')

    await connectAccount(server, fake, { user: 'work', requestId: card.id })
    await expect.poll(() => fake.calls.length).toBe(1)
    await untilIdle(server, rex)

    expect((await cardNow(server, card)).card).toMatchObject({ decision: { outcome: 'granted', account: { slug: 'account2', displayName: 'Account 2' } } })
    expect((await server.client.plugins.get({ name: 'notes' })).accounts).toMatchObject([{ slug: 'account1', grantedTo: [] }, { slug: 'account2', grantedTo: [rex.id] }])
    expect(fake.calls).toEqual([{ tool: 'search_pages', args: { query: 'trip' }, user: 'work' }])
  })

  it('records Deny and wakes the bot with it, granting nothing', async () => {
    const { server, rex, card } = await requestedByRex()
    server.providers.script(callsTools(['sendMessage', { text: "OK, I'll do without" }]), endsSilently())

    const decided = await server.client.chats.decidePluginRequest({ messageId: card.id, decision: { outcome: 'denied' } })
    await untilIdle(server, rex)

    expect(decided.card).toMatchObject({ decision: { outcome: 'denied' } })
    expect((await server.client.plugins.get({ name: 'notes' })).accounts[0]!.grantedTo).toEqual([])
    expect(inputs(server, 1).at(-1)).toContain('The owner denied your request for Notes')
    expect(server.providers.requests[1]!.tools).not.toContain(notesSearch)
  })

  it('is decided once, and refuses an account the plugin lacks or a request of another plugin', async () => {
    const { server, fake, card } = await requestedByRex()
    server.providers.script(callsTools(['sendMessage', { text: 'OK' }]), endsSilently())

    await expect(server.client.chats.decidePluginRequest({ messageId: card.id, decision: { outcome: 'granted', account: 'account9' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.chats.decidePluginRequest({ messageId: card.id, decision: { outcome: 'granted', account: null } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(connectAccount(server, fake, { name: 'tasks', requestId: card.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await server.client.chats.decidePluginRequest({ messageId: card.id, decision: { outcome: 'denied' } })
    await expect(server.client.chats.decidePluginRequest({ messageId: card.id, decision: { outcome: 'granted', account: 'account1' } })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(connectAccount(server, fake, { requestId: card.id })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await server.client.plugins.get({ name: 'notes' })).accounts).toHaveLength(1)
  })

  it('grants a plugin of skills only without an account', async () => {
    const { server } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    server.providers.script(callsTools(['request_plugin', { plugin: 'style', reason: 'To write in your house style' }]))
    await send(server, rex, 'Write the newsletter')
    const card = (await server.client.chats.messages({ chatId: rex.chatId })).at(-1)!
    server.providers.script(callsTools(['sendMessage', { text: 'Thanks' }]), endsSilently())

    const decided = await server.client.chats.decidePluginRequest({ messageId: card.id, decision: { outcome: 'granted', account: null } })
    await untilIdle(server, rex)

    expect(decided.card).toMatchObject({ skillsOnly: true, decision: { outcome: 'granted', account: null } })
    expect((await server.client.plugins.get({ name: 'style' })).grantedTo).toEqual([rex.id])
    expect(inputs(server, 1).at(-1)).toContain('The owner granted you Style')
  })

  it('is reviewed and audited under the plugin_request surface', async () => {
    const { server, rex } = await requestedByRex()

    expect(await server.client.bots.audit({ botId: rex.id })).toMatchObject([{ kind: 'action', surface: 'plugin_request', tool: 'request_plugin', input: tripNotes }])
  })
})
