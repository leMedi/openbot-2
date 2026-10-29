import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo, NewBot, SearchResults } from '@openbot/api-contract'
import { openDbBefore } from '@openbot/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const profile = (name: string): NewBot => ({
  name,
  title: null,
  instructions: '',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
})

/** A server with these bots, ready to run on the fake model. */
async function startWith(...names: string[]) {
  const server = await createTestServer()
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bots: BotInfo[] = []
  for (const name of names) bots.push(await server.client.bots.create(profile(name)))
  return { server, bots }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** The owner sends `text` (and `files`) to `bot`, which answers `reply`, or nothing. */
async function say(server: TestServer, bot: BotInfo, text: string, reply?: string, files: File[] = []) {
  server.providers.script(...(reply ? [callsTools(['sendMessage', { text: reply }]), endsSilently()] : [endsSilently()]))
  await server.client.chats.send({ chatId: bot.chatId, text, files })
  await untilIdle(server, bot)
}

/** Each message hit as "author: text", its matched words in [brackets]. */
const hits = (results: SearchResults) =>
  results.messages.map((hit) => `${hit.authorName}: ${hit.snippet.map((part) => (part.match ? `[${part.text}]` : part.text)).join('')}`)

describe('searching messages', () => {
  it("finds the owner's and bots' messages in every chat by word prefix, newest first", async () => {
    const { server, bots } = await startWith('Rex', 'Ana')
    const [rex, ana] = bots as [BotInfo, BotInfo]
    await say(server, rex, 'Deploy the staging server', 'Staging is deployed.')
    await say(server, ana, 'Write the release notes', 'Notes are in the wiki.')

    const results = await server.client.chats.search({ query: 'stag' })

    expect(hits(results)).toEqual(['Rex: [Staging] is deployed.', 'You: Deploy the [staging] server'])
    expect(results.messages[0]).toMatchObject({ chatId: rex.chatId, author: 'bot', botMessage: null })
    expect(results.messages[1]).toMatchObject({ chatId: rex.chatId, author: 'owner' })
  })

  it('needs every word to match, in any order', async () => {
    const { server, bots } = await startWith('Rex')
    await say(server, bots[0]!, 'The staging server is down')
    await say(server, bots[0]!, 'The production server is fine')

    expect(hits(await server.client.chats.search({ query: 'server stag' }))).toEqual(['You: The [staging] [server] is down'])
  })

  it('searches hidden chats too, and forgets a deleted one', async () => {
    const { server, bots } = await startWith('Rex', 'Ana')
    const [rex, ana] = bots as [BotInfo, BotInfo]
    await say(server, rex, 'Rotate the API keys')
    await say(server, ana, 'Check the API quota')
    await server.client.chats.hide({ chatIds: [rex.chatId] })
    await server.client.bots.delete({ botId: ana.id })

    expect(hits(await server.client.chats.search({ query: 'api' }))).toEqual(['You: Rotate the [API] keys'])
  })

  it('treats quotes, operators and stars as plain words, and finds nothing for a blank query', async () => {
    const { server, bots } = await startWith('Rex')
    await say(server, bots[0]!, 'Fix "NEAR" OR the AND gate*')

    expect(hits(await server.client.chats.search({ query: '"near' }))).toEqual(['You: Fix "[NEAR]" OR the AND gate*'])
    expect(hits(await server.client.chats.search({ query: 'OR AND' }))).toEqual(['You: Fix "NEAR" [OR] the [AND] gate*'])
    expect(await server.client.chats.search({ query: '  ' })).toEqual({ messages: [], files: [] })
    expect(await server.client.chats.search({ query: '*' })).toEqual({ messages: [], files: [] })
  })

  it('finds files by name', async () => {
    const { server, bots } = await startWith('Rex')
    const file = (name: string) => new File(['…'], name, { type: 'text/plain' })
    await say(server, bots[0]!, 'Here you go', undefined, [file('Q3 report.txt'), file('notes.txt')])

    const results = await server.client.chats.search({ query: 'repo' })

    expect(results.messages).toEqual([])
    expect(results.files).toEqual([
      expect.objectContaining({ chatId: bots[0]!.chatId, authorName: 'You', attachment: expect.objectContaining({ name: 'Q3 report.txt', mimeType: 'text/plain' }) }),
    ])
  })
})

describe('the search index', () => {
  it('holds the messages posted before it existed', async () => {
    const server = await createTestServer()
    await server.shutdown()
    const file = join(server.dataDir, 'openbot.db')
    await rm(file)
    const legacy = await openDbBefore(file, '0019_message_search')
    await legacy.$client.batch([
      `INSERT INTO chats (id, kind) VALUES ('group', 'group')`,
      `INSERT INTO messages (id, chat_id, author, author_name, text) VALUES ('m1', 'group', 'owner', 'You', 'Ship the beta on Friday')`,
    ])
    legacy.$client.close()

    const restarted = await restartTestServer(server)
    servers.push(restarted)

    expect(hits(await restarted.client.chats.search({ query: 'beta' }))).toEqual(['You: Ship the [beta] on Friday'])
  })
})
