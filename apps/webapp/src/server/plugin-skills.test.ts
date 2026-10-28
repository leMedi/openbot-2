import { join } from 'node:path'
import { callsTools, endsSilently, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'
import { closePluginFixtures, connectAccount, type FixturePlugin, hostedPlugin, writeCatalog } from './testing/plugins.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await closePluginFixtures()
})

const newBot = (name: string): NewBot => ({ name, title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })

const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

/** A plugin of skills only: no server, so no account to connect. */
const recipes: FixturePlugin = {
  '.claude-plugin/plugin.json': { name: 'recipes', displayName: 'Recipes', description: 'Cooking know-how' },
  'skills/meal-plans/SKILL.md': skill('meal-plans', 'Plan a week of meals for the owner', 'Ask about allergies first. See shopping.md for the list.'),
  'skills/meal-plans/shopping.md': 'Group the shopping list by aisle.\n',
}

/**
 * A server whose catalog has Notes, hosted on a fake MCP server with one account connected and a skill of its own,
 * and Recipes, of skills only; with Rex.
 */
async function start() {
  const { fake, plugin } = await hostedPlugin('notes')
  const notes: FixturePlugin = { ...plugin, 'skills/note-taking/SKILL.md': skill('note-taking', 'File notes where the owner keeps them', 'Title every note.') }
  const server = await createTestServer({ catalog: await writeCatalog({ notes, recipes }), compaction: { keepRecentTokens: 1 } })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  await connectAccount(server, fake)
  const bot = await server.client.bots.create(newBot('Rex'))
  return { server, bot }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** The bot's instructions in the request of its next run: every system message, in order. */
async function nextPrompt(server: TestServer, bot: BotInfo) {
  server.providers.script(endsSilently())
  await server.runtime.wake(bot.id, { lane: 'background', text: '[test] look around' })
  await untilIdle(server, bot)
  return server.providers.requests
    .at(-1)!
    .messages.flatMap((message) => (message.role === 'system' ? [JSON.stringify(message.content), JSON.stringify(message.sections ?? {})] : []))
    .join('\n')
}

/** Compacts the bot's history, as pi-durable does near the context window: a new compaction epoch. */
async function compact(server: TestServer, bot: BotInfo) {
  server.providers.script(says('Summary so far.'))
  await server.runtime.compact(bot.id)
}

/** Where a plugin's skill is copied for bots to read. */
const skillFile = (server: TestServer, plugin: string, folder: string) => join(server.home, 'plugins', plugin, 'skills', folder, 'SKILL.md')

describe("a granted plugin's skills", () => {
  it("are listed in the bot's prompt, with where to read them; an ungranted plugin's aren't", async () => {
    const { server, bot } = await start()
    await server.client.plugins.grant({ name: 'notes', account: 'account1', botId: bot.id })

    const prompt = await nextPrompt(server, bot)

    expect(prompt).toContain('<name>note-taking</name>')
    expect(prompt).toContain('<description>File notes where the owner keeps them</description>')
    expect(prompt).toContain(`<location>${skillFile(server, 'notes', 'note-taking')}</location>`)
    expect(prompt).not.toContain('meal-plans')
  })

  it('of a plugin of skills only are granted and revoked without an account, from the bot\'s next compaction epoch', async () => {
    const { server, bot } = await start()
    expect(await nextPrompt(server, bot)).not.toContain('meal-plans')

    expect(await server.client.plugins.grantSkills({ name: 'recipes', botId: bot.id })).toMatchObject({ name: 'recipes', grantedTo: [bot.id], accounts: [] })
    expect(await nextPrompt(server, bot)).not.toContain('meal-plans')
    await compact(server, bot)
    const granted = await nextPrompt(server, bot)
    expect(granted).toContain('<name>meal-plans</name>')
    expect(granted).toContain(`<location>${skillFile(server, 'recipes', 'meal-plans')}</location>`)
    expect((await server.client.plugins.get({ name: 'recipes' })).grantedTo).toEqual([bot.id])

    expect(await server.client.plugins.revokeSkills({ name: 'recipes', botId: bot.id })).toMatchObject({ grantedTo: [] })
    expect(await nextPrompt(server, bot)).toContain('meal-plans')
    await compact(server, bot)
    expect(await nextPrompt(server, bot)).not.toContain('meal-plans')
  })

  it('of a plugin with a server are granted only with one of its accounts', async () => {
    const { server, bot } = await start()

    await expect(server.client.plugins.grantSkills({ name: 'notes', botId: bot.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(server.client.plugins.grantSkills({ name: 'nope', botId: bot.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.plugins.grantSkills({ name: 'recipes', botId: 'nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await server.client.plugins.get({ name: 'notes' })).grantedTo).toEqual([])
  })

  it('are read by the bot from the read-only copy on its computer, with the files beside them', async () => {
    const { server, bot } = await start()
    await server.client.plugins.grantSkills({ name: 'recipes', botId: bot.id })
    const folder = join(server.home, 'plugins', 'recipes', 'skills', 'meal-plans')
    server.providers.script(callsTools(['read', { path: join(folder, 'SKILL.md') }]), callsTools(['read', { path: join(folder, 'shopping.md') }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Plan my meals for the week' })
    await untilIdle(server, bot)

    const read = server.providers.requests.slice(1).map((request) => JSON.stringify(request.messages.at(-1)))
    expect(read[0]).toContain('Ask about allergies first.')
    expect(read[1]).toContain('Group the shopping list by aisle.')
  })

  it('are gone with the bot', async () => {
    const { server, bot } = await start()
    await server.client.plugins.grantSkills({ name: 'recipes', botId: bot.id })

    await server.client.bots.delete({ botId: bot.id })

    expect((await server.client.plugins.list()).find((plugin) => plugin.name === 'recipes')!.grantedTo).toEqual([])
  })
})
