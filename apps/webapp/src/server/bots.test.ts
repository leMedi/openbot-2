import { callsTools, endsSilently, held } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { auditLog, chats, messages } from '@openbot/db'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
async function start() {
  const server = await createTestServer()
  servers.push(server)
  return server
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = {
  name: 'Rex',
  title: 'Builder',
  instructions: 'Rex fixes builds and never gives up.',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
}

describe('onboarding', () => {
  it('stays unfinished until a provider, a default model and a bot exist', async () => {
    const server = await start()
    expect(await server.client.onboarding.status()).toEqual({ provider: false, defaultModel: false, bot: false, done: false })

    await server.connectProvider()
    expect(await server.client.onboarding.status()).toEqual({ provider: true, defaultModel: false, bot: false, done: false })

    await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
    expect(await server.client.onboarding.status()).toEqual({ provider: true, defaultModel: true, bot: false, done: false })

    await server.client.bots.create(rex)
    expect(await server.client.onboarding.status()).toEqual({ provider: true, defaultModel: true, bot: true, done: true })
  })
})

describe('bots', () => {
  it('creates a bot with its own DM', async () => {
    const server = await start()
    await server.connectProvider()

    const created = await server.client.bots.create(rex)

    expect(created).toEqual({ ...rex, id: expect.any(String), chatId: expect.any(String), working: false, error: null })
    expect(await server.client.bots.list()).toEqual([created])
    expect(await server.client.chats.messages({ chatId: created.chatId })).toEqual([])
  })

  it('rejects a name already in use, ignoring case', async () => {
    const server = await start()
    await server.connectProvider()
    await server.client.bots.create(rex)

    await expect(server.client.bots.create({ ...rex, name: 'REX' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await server.client.bots.list()).toHaveLength(1)
  })

  it('rejects a bot without a name', async () => {
    const server = await start()

    await expect(server.client.bots.create({ ...rex, name: '  ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('only accepts a model override from a connected provider', async () => {
    const server = await start()

    await expect(server.client.bots.create({ ...rex, model: 'fake/fake-mini' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await server.connectProvider()
    expect((await server.client.bots.create({ ...rex, model: 'fake/fake-mini' })).model).toBe('fake/fake-mini')
  })
})

describe('editing a bot', () => {
  it("changes the bot's profile, one field at a time", async () => {
    const server = await start()
    const bot = await server.client.bots.create(rex)

    await server.client.bots.update({ botId: bot.id, title: 'Release engineer' })
    const updated = await server.client.bots.update({ botId: bot.id, name: 'Rexy', avatarShape: 'cloud', avatarColor: 'red' })

    expect(updated).toEqual({ ...bot, name: 'Rexy', title: 'Release engineer', avatarShape: 'cloud', avatarColor: 'red' })
    expect(await server.client.bots.list()).toEqual([updated])
  })

  it("rejects another bot's name, ignoring case, but lets a bot change its own name's case", async () => {
    const server = await start()
    const bot = await server.client.bots.create(rex)
    await server.client.bots.create({ ...rex, name: 'Ana' })

    await expect(server.client.bots.update({ botId: bot.id, name: 'ANA' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(server.client.bots.update({ botId: bot.id, name: ' ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect((await server.client.bots.update({ botId: bot.id, name: 'REX' })).name).toBe('REX')
  })

  it('overrides the default model with a connected one, and resets to follow the default again', async () => {
    const server = await start()
    const bot = await server.client.bots.create(rex)

    await expect(server.client.bots.update({ botId: bot.id, model: 'fake/fake-mini' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await server.connectProvider()
    expect((await server.client.bots.update({ botId: bot.id, model: 'fake/fake-mini' })).model).toBe('fake/fake-mini')
    expect((await server.client.bots.update({ botId: bot.id, model: null })).model).toBeNull()
  })

  it("doesn't edit a bot that doesn't exist", async () => {
    const server = await start()

    await expect(server.client.bots.update({ botId: 'nope', title: 'Ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('deleting a bot', () => {
  async function startWithBots() {
    const server = await start()
    await server.connectProvider()
    await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
    const rexBot = await server.client.bots.create(rex)
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', instructions: 'Ana reviews code.' })
    return { server, rexBot, ana }
  }

  async function untilIdle(server: TestServer, bot: BotInfo) {
    await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
  }

  /** Every row of every table, as JSON; group chats and bot-to-bot messages have no API yet. */
  async function allRows(server: TestServer) {
    const tables = await server.db.$client.execute("select name from sqlite_master where type = 'table' and name not like '\\_\\_%' escape '\\'")
    const rows = await Promise.all(tables.rows.map(async ({ name }) => (await server.db.$client.execute(`select * from "${name}"`)).rows))
    return rows.flat().map((row) => JSON.stringify(row))
  }

  it('removes everything it owns, leaving only copies of its name', async () => {
    const { server, rexBot, ana } = await startWithBots()
    server.providers.script(callsTools(['sendMessage', { text: 'On it' }]), endsSilently())
    await server.client.chats.send({ chatId: rexBot.chatId, text: 'Fix the build' })
    await untilIdle(server, rexBot)
    await server.db.insert(auditLog).values({
      botId: rexBot.id,
      surface: 'shell',
      tool: 'shell',
      action: { command: 'make' },
      verdict: { decision: 'allow' },
      mode: 'shadow',
    })
    const [group] = await server.db.insert(chats).values({ kind: 'group', members: [rexBot.id, ana.id] }).returning()
    await server.db.insert(messages).values([
      { chatId: group!.id, author: 'bot', authorBotId: rexBot.id, authorName: 'Rex', text: 'Build is green' },
      {
        chatId: ana.chatId,
        author: 'bot',
        authorBotId: rexBot.id,
        authorName: 'Rex',
        direction: 'from',
        peerBotId: rexBot.id,
        peerName: 'Rex',
        text: 'Can you review my fix?',
      },
    ])
    expect((await allRows(server)).filter((row) => row.includes(rexBot.id)).length).toBeGreaterThan(0)

    await server.client.bots.delete({ botId: rexBot.id })

    expect((await server.client.bots.list()).map((bot) => bot.name)).toEqual(['Ana'])
    await expect(server.client.chats.messages({ chatId: rexBot.chatId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const [{ members }] = (await server.db.$client.execute({ sql: 'select members from chats where id = ?', args: [group!.id] })).rows as unknown as [{ members: string }]
    expect(JSON.parse(members)).toEqual([ana.id])
    expect((await allRows(server)).filter((row) => row.includes(rexBot.id))).toEqual([])
    const left = (await allRows(server)).filter((row) => row.includes('Rex'))
    expect(left).toHaveLength(2)
    expect(left.join()).not.toMatch(/Fix the build|On it/)
  })

  it('shows its messages in other chats as "Name (deleted)"', async () => {
    const { server, rexBot, ana } = await startWithBots()
    const [group] = await server.db.insert(chats).values({ kind: 'group', members: [rexBot.id, ana.id] }).returning()
    await server.db.insert(messages).values([
      { chatId: group!.id, author: 'bot', authorBotId: rexBot.id, authorName: 'Rex', text: 'Build is green' },
      { chatId: group!.id, author: 'bot', authorBotId: ana.id, authorName: 'Ana', text: 'Nice' },
    ])

    await server.client.bots.delete({ botId: rexBot.id })

    expect((await server.client.chats.messages({ chatId: group!.id })).map((message) => [message.authorName, message.botId])).toEqual([
      ['Rex (deleted)', null],
      ['Ana', ana.id],
    ])
  })

  it('stops a working bot first, and a new bot with its name starts with an empty history', async () => {
    const { server, rexBot } = await startWithBots()
    const running = held(callsTools(['sendMessage', { text: 'Still working on it' }]))
    server.providers.script(running)
    await server.client.chats.send({ chatId: rexBot.chatId, text: 'Remember the word banana' })
    await running.requested

    await server.client.bots.delete({ botId: rexBot.id })
    running.release()

    const again = await server.client.bots.create(rex)
    expect(again.id).not.toBe(rexBot.id)
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())
    await server.client.chats.send({ chatId: again.chatId, text: 'What was the word?' })
    await untilIdle(server, again)
    expect(JSON.stringify(server.providers.requests.at(-1)!.messages)).not.toContain('banana')
    expect((await server.client.chats.messages({ chatId: again.chatId })).map((message) => message.text)).toEqual(['What was the word?', 'Hi'])
  })

  it("doesn't delete a bot that doesn't exist", async () => {
    const server = await start()

    await expect(server.client.bots.delete({ botId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
