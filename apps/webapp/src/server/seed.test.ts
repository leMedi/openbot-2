import { listChatSummaries } from '@openbot/core'
import { afterEach, describe, expect, it } from 'vitest'
import { sampleBots, sampleGroupTitle, seedSampleData } from './seed.ts'
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

async function groups(server: TestServer) {
  return (await listChatSummaries(server.db)).filter((chat) => chat.kind === 'group')
}

describe('dev seed', () => {
  it('creates the sample bots, each with its DM, and a group chat with all of them', async () => {
    const server = await start()

    await seedSampleData(server.db)

    const bots = await server.client.bots.list()
    expect(bots.map((bot) => bot.name)).toEqual(sampleBots.map((bot) => bot.name))
    const [group, ...more] = await groups(server)
    expect(more).toEqual([])
    expect(group).toMatchObject({ title: sampleGroupTitle, botId: null })
    expect(group!.members).toEqual(bots.map((bot) => bot.id))
    const sidebar = await server.client.chats.list()
    expect(sidebar.map((chat) => chat.kind).sort()).toEqual([...sampleBots.map(() => 'dm'), 'group'])
  })

  it('can run again without duplicating anything', async () => {
    const server = await start()

    await seedSampleData(server.db)
    await seedSampleData(server.db)

    expect(await server.client.bots.list()).toHaveLength(sampleBots.length)
    expect(await groups(server)).toHaveLength(1)
  })

  it("keeps the owner's bots, and reuses one that already has a sample bot's name", async () => {
    const server = await start()
    const own = await server.client.bots.create({
      name: 'rex',
      title: 'Mine',
      instructions: '',
      avatarShape: 'hex',
      avatarColor: 'blue',
      model: null,
    })
    await server.client.bots.create({ ...sampleBots[0]!, name: sampleBots[0]!.name.toUpperCase() })

    await seedSampleData(server.db)

    const bots = await server.client.bots.list()
    expect(bots).toHaveLength(sampleBots.length + 1)
    expect(bots).toContainEqual(own)
    expect((await groups(server))[0]!.members).toHaveLength(sampleBots.length)
  })
})
