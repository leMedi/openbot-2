import type { NewBot } from '@openbot/api-contract'
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
  handle: 'rex',
  title: 'Builder',
  persona: 'Rex fixes builds and never gives up.',
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

  it('rejects a handle already in use', async () => {
    const server = await start()
    await server.connectProvider()
    await server.client.bots.create(rex)

    await expect(server.client.bots.create({ ...rex, name: 'Rex Two' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await server.client.bots.list()).toHaveLength(1)
  })

  it('rejects handles that cannot be mentioned', async () => {
    const server = await start()

    await expect(server.client.bots.create({ ...rex, handle: 'Rex Bot' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('only accepts a model override from a connected provider', async () => {
    const server = await start()

    await expect(server.client.bots.create({ ...rex, model: 'fake/fake-mini' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await server.connectProvider()
    expect((await server.client.bots.create({ ...rex, model: 'fake/fake-mini' })).model).toBe('fake/fake-mini')
  })
})
