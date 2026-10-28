import type { FakeMcpTool } from '@openbot/agent/testing'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'
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

/** A server whose catalog has the hosted plugin Notes, with one account connected as `owner` and renamed Work. */
async function start() {
  const { fake, plugin } = await hostedPlugin('notes', [searchPages])
  const catalog = await writeCatalog({ notes: plugin })
  const server = await createTestServer({ catalog })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  await connectAccount(server, fake)
  await server.client.plugins.renameAccount({ name: 'notes', account: 'account1', displayName: 'Work' })
  return { server, fake, catalog }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

async function send(server: TestServer, bot: BotInfo, text: string) {
  await server.client.chats.send({ chatId: bot.chatId, text })
  await untilIdle(server, bot)
}

/** A bot granted the account. */
async function grantedBot(server: TestServer, name: string) {
  const bot = await server.client.bots.create(newBot(name))
  await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: bot.id })
  return bot
}

/** The tool results of the run, as the model read them in its last request. */
const toolResults = (server: TestServer) =>
  server.providers.requests.at(-1)!.messages.flatMap((message) =>
    message.role === 'toolResult' ? [{ tool: message.toolName, isError: message.isError, text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join('') }] : [],
  )

const notesSearch = 'mcp__notes_account1__search_pages'

/** The bot loads the Notes tools and searches for `query` with them. */
const searches = (server: TestServer, query: string, bot?: string) => {
  const turns = [callsTools(['tool_search', { query: 'search notes pages' }]), callsTools([notesSearch, { query }]), endsSilently()] as const
  if (bot) server.providers.scriptFor(bot, ...turns)
  else server.providers.script(...turns)
}

describe('an expired plugin sign-in', () => {
  it('is refreshed when the server rejects a call, and the call succeeds; the new tokens are stored', async () => {
    const { server, fake, catalog } = await start()
    const rex = await grantedBot(server, 'Rex')
    searches(server, 'trip')
    await send(server, rex, 'Find my trip notes')

    fake.expireAccessTokens()
    searches(server, 'budget')
    await send(server, rex, 'And my budget notes')

    expect(fake.calls.map((call) => call.args.query)).toEqual(['trip', 'budget'])
    expect(toolResults(server).at(-1)).toEqual({ tool: notesSearch, isError: false, text: 'Found 2 pages about budget.' })

    // The old refresh token was spent: a server that restarts with the tokens it stored signs in without one.
    const issued = fake.issuedTokens.length
    const restarted = await restartTestServer(servers.pop()!, { catalog })
    servers.push(restarted)
    searches(restarted, 'roadmap')
    await send(restarted, rex, 'And my roadmap')

    expect(fake.calls.map((call) => call.args.query)).toEqual(['trip', 'budget', 'roadmap'])
    expect(fake.issuedTokens).toHaveLength(issued)
  })

  it("that can't be refreshed marks the account Needs reconnect, answers the call so, and posts one Reconnect card per granted bot", async () => {
    const { server, fake } = await start()
    const rex = await grantedBot(server, 'Rex')
    const ada = await grantedBot(server, 'Ada')
    const bob = await server.client.bots.create(newBot('Bob'))
    searches(server, 'trip', 'Rex')
    await send(server, rex, 'Find my trip notes')

    fake.expireSignIns()
    searches(server, 'budget', 'Rex')
    await send(server, rex, 'And my budget notes')
    server.providers.scriptFor('Rex', callsTools([notesSearch, { query: 'roadmap' }]), endsSilently())
    await send(server, rex, 'And my roadmap')

    expect(fake.calls.map((call) => call.args.query)).toEqual(['trip'])
    expect(toolResults(server).at(-1)).toMatchObject({ tool: notesSearch, isError: true, text: expect.stringContaining('the owner must reconnect it') })
    expect(toolResults(server).at(-1)!.text).toContain('Notes (Work)')
    expect((await server.client.plugins.get({ name: 'notes' })).accounts).toMatchObject([{ slug: 'account1', needsReconnect: true, grantedTo: [rex.id, ada.id] }])

    const cards = async (bot: BotInfo) => (await server.client.chats.messages({ chatId: bot.chatId })).filter((message) => message.card?.type === 'plugin_reconnect')
    expect(await cards(rex)).toMatchObject([
      { author: 'bot', authorName: 'Rex', card: { type: 'plugin_reconnect', plugin: 'notes', displayName: 'Notes', account: { slug: 'account1', displayName: 'Work' }, outcome: null } },
    ])
    expect(await cards(ada)).toHaveLength(1)
    expect(await cards(bob)).toHaveLength(0)
    const chat = (await server.client.chats.list()).find((entry) => entry.id === ada.chatId)!
    expect(chat.waitingFor).toBe((await cards(ada))[0]!.text)
  })

  it('is reconnected from the Reconnect card, keeping the slug and grants, closing every card, and the next call works', async () => {
    const { server, fake } = await start()
    const rex = await grantedBot(server, 'Rex')
    const ada = await grantedBot(server, 'Ada')
    searches(server, 'trip', 'Rex')
    await send(server, rex, 'Find my trip notes')
    fake.expireSignIns()
    searches(server, 'budget', 'Rex')
    await send(server, rex, 'And my budget notes')

    const steps = await connectAccount(server, fake, { account: 'account1' })
    server.providers.scriptFor('Rex', callsTools([notesSearch, { query: 'budget' }]), endsSilently())
    await send(server, rex, 'Try again')

    expect(steps.at(-1)).toEqual({ type: 'connected' })
    expect(fake.calls.map((call) => call.args.query)).toEqual(['trip', 'budget'])
    expect(toolResults(server).at(-1)).toEqual({ tool: notesSearch, isError: false, text: 'Found 2 pages about budget.' })
    expect(await server.client.plugins.get({ name: 'notes' })).toMatchObject({
      accounts: [{ slug: 'account1', displayName: 'Work', needsReconnect: false, grantedTo: [rex.id, ada.id] }],
    })
    for (const bot of [rex, ada]) {
      const cards = (await server.client.chats.messages({ chatId: bot.chatId })).filter((message) => message.card?.type === 'plugin_reconnect')
      expect(cards.map((message) => message.card)).toMatchObject([{ outcome: 'reconnected' }])
      expect((await server.client.chats.list()).find((entry) => entry.id === bot.chatId)!.waitingFor).toBeNull()
    }
  })

  it('refuses to reconnect an account the plugin lacks', async () => {
    const { server, fake } = await start()

    await expect(connectAccount(server, fake, { account: 'account9' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('closes the Reconnect cards when the account is disconnected instead', async () => {
    const { server, fake } = await start()
    const rex = await grantedBot(server, 'Rex')
    searches(server, 'trip')
    await send(server, rex, 'Find my trip notes')
    fake.expireSignIns()
    searches(server, 'budget')
    await send(server, rex, 'And my budget notes')

    await server.client.plugins.disconnectAccount({ name: 'notes', account: 'account1' })

    const cards = (await server.client.chats.messages({ chatId: rex.chatId })).filter((message) => message.card?.type === 'plugin_reconnect')
    expect(cards.map((message) => message.card)).toMatchObject([{ outcome: 'disconnected' }])
    expect((await server.client.chats.list()).find((entry) => entry.id === rex.chatId)!.waitingFor).toBeNull()
  })

  it('shows in search_plugins, also after a restart, when the bot has no tools of the account left to call', async () => {
    const { server, fake, catalog } = await start()
    const rex = await grantedBot(server, 'Rex')
    searches(server, 'trip')
    await send(server, rex, 'Find my trip notes')
    fake.expireSignIns()
    searches(server, 'budget')
    await send(server, rex, 'And my budget notes')

    const restarted = await restartTestServer(servers.pop()!, { catalog })
    servers.push(restarted)
    restarted.providers.script(callsTools(['search_plugins', {}]), endsSilently())
    await send(restarted, rex, 'Can you reach my notes?')

    expect(toolResults(restarted).at(-1)!.text).toContain('Granted to you: Work (needs reconnecting by the owner)')
  })
})
