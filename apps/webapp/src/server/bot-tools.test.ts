import { type BotTool } from '@openbot/agent'
import { callsTools, endsSilently, held, recordingTool } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const newBot = (name: string): NewBot => ({ name, title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })

const searchPages = 'mcp__notes_account1__search_pages'

/** A server whose bots' own tools are what `granted` holds for them when asked, or fail to be read with its error. */
async function start() {
  const granted = new Map<string, BotTool[] | Error>()
  const server = await createTestServer({
    botTools: async (botId) => {
      const tools = granted.get(botId) ?? []
      if (tools instanceof Error) throw tools
      return tools
    },
  })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  return { server, granted }
}

async function send(server: TestServer, bot: BotInfo, text: string) {
  await server.client.chats.send({ chatId: bot.chatId, text })
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** What the tool results of the run told the model, from the request after them. */
const toolResults = (server: TestServer, request: number) =>
  server.providers.requests[request]!.messages.flatMap((message) =>
    message.role === 'toolResult' ? [{ tool: message.toolName, isError: message.isError, text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join('') }] : [],
  )

describe("a bot's own tools", () => {
  it('are deferred until the bot finds them with tool_search, then it can call them', async () => {
    const { server, granted } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const search = recordingTool(searchPages, 'mcp', { description: 'Search the pages of a notes workspace', result: 'Found 2 pages.' })
    granted.set(rex.id, [search.tool])
    server.providers.script(callsTools(['tool_search', { query: 'search notes pages' }]), callsTools([searchPages, { query: 'trip' }]), endsSilently())

    await send(server, rex, 'Find my trip notes')

    const [first, second] = server.providers.requests
    expect(first!.tools).toContain('tool_search')
    expect(first!.tools).not.toContain(searchPages)
    expect(second!.tools).toContain(searchPages)
    expect(search.calls).toEqual([{ query: 'trip' }])
    expect(toolResults(server, 2).at(-1)).toMatchObject({ tool: searchPages, isError: false, text: 'Found 2 pages.' })
  })

  it("are only that bot's: another bot neither finds nor can call them", async () => {
    const { server, granted } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))
    const search = recordingTool(searchPages, 'mcp', { description: 'Search the pages of a notes workspace' })
    granted.set(rex.id, [search.tool])
    server.providers.scriptFor('Ada', callsTools([searchPages, { query: 'trip' }]), endsSilently())

    await send(server, ada, 'Find my trip notes')

    expect(server.providers.requests[0]!.tools).not.toContain('tool_search')
    expect(search.calls).toEqual([])
    expect(toolResults(server, 1)).toMatchObject([{ tool: searchPages, isError: true }])
  })

  it('fail cleanly once the bot no longer has them, between runs, and its history goes on', async () => {
    const { server, granted } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const search = recordingTool(searchPages, 'mcp', { description: 'Search the pages of a notes workspace' })
    granted.set(rex.id, [search.tool])
    server.providers.script(callsTools(['tool_search', { query: 'notes pages' }]), callsTools([searchPages, { query: 'trip' }]), endsSilently())
    await send(server, rex, 'Find my trip notes')

    granted.delete(rex.id)
    server.providers.script(callsTools([searchPages, { query: 'budget' }]), callsTools(['sendMessage', { text: "I can't reach your notes any more." }]), endsSilently())
    await send(server, rex, 'And my budget notes?')

    expect(search.calls).toEqual([{ query: 'trip' }])
    expect(server.providers.requests[3]!.tools).not.toContain(searchPages)
    expect(toolResults(server, 4).at(-1)).toMatchObject({ tool: searchPages, isError: true, text: expect.stringContaining('not available') })
    expect((await server.client.chats.messages({ chatId: rex.chatId })).at(-1)?.text).toBe("I can't reach your notes any more.")
  })

  it('are checked at each call, so one lost during a run fails with a clear answer', async () => {
    const { server, granted } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const search = recordingTool(searchPages, 'mcp', { description: 'Search the pages of a notes workspace' })
    granted.set(rex.id, [search.tool])
    const call = held(callsTools([searchPages, { query: 'trip' }]))
    server.providers.script(callsTools(['tool_search', { query: 'notes pages' }]), call, endsSilently())
    const sent = send(server, rex, 'Find my trip notes')

    // Revoked once the bot has loaded the tool, before it calls it.
    await call.requested
    granted.delete(rex.id)
    call.release()
    await sent

    expect(search.calls).toEqual([])
    expect(toolResults(server, 2).at(-1)).toMatchObject({ tool: searchPages, isError: true, text: expect.stringContaining("isn't available to you any more") })
  })

  it('go through the orchestrator under their surface, into the audit log', async () => {
    const { server, granted } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const search = recordingTool(searchPages, 'mcp', { description: 'Search the pages of a notes workspace' })
    granted.set(rex.id, [search.tool])
    server.providers.script(callsTools(['tool_search', { query: 'notes pages' }]), callsTools([searchPages, { query: 'trip' }]), endsSilently())

    await send(server, rex, 'Find my trip notes')

    expect(await server.client.bots.audit({ botId: rex.id })).toMatchObject([{ kind: 'action', surface: 'mcp', tool: searchPages, input: { query: 'trip' } }])
  })

  it("can't be read for a while without the bot losing its run", async () => {
    const { server, granted } = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    granted.set(rex.id, new Error('The tool server is down'))
    server.providers.script(callsTools(['sendMessage', { text: 'On it.' }]), endsSilently())

    await send(server, rex, 'Hello')

    expect((await server.client.chats.messages({ chatId: rex.chatId })).at(-1)?.text).toBe('On it.')
  })
})
