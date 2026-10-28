import { callsTools, endsSilently, fails, held, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer, type TestServerOptions } from './testing/harness.ts'

const servers: TestServer[] = []
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

const day = 24 * 60 * 60 * 1000

/**
 * A finished onboarding with Rex, in Paris, on a server whose clock starts at noon UTC on 2026-10-28 and that
 * consolidates memory nightly on `fake/fake-memory`.
 */
async function startWithRex(options: TestServerOptions = {}) {
  const server = await createTestServer({ now: new Date('2026-10-28T12:00:00Z'), consolidation: true, ...options })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' })
  const bot = await server.client.bots.create(rex)
  return { server, bot }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** The bot calls `update_state` with `args`, then ends its run silently. */
async function updateState(server: TestServer, bot: BotInfo, args: Record<string, unknown>) {
  server.providers.script(callsTools(['update_state', { target: 'memory', ...args } as never]), endsSilently())
  await server.runtime.wake(bot.id, { lane: 'background', text: '[test] update your memory' })
  await untilIdle(server, bot)
}

/** What the memory model was asked to consolidate, in order: each such request's prompt. */
const consolidationPrompts = (server: TestServer) =>
  server.providers.requests
    .filter((request) => request.model === server.providers.memoryModel.ref && JSON.stringify(request.messages).includes('<facts scope='))
    .map((request) => JSON.stringify(request.messages))

/** What the memory model was asked to verify, in order: each such request's prompt. */
const verificationPrompts = (server: TestServer) =>
  server.providers.requests
    .filter((request) => request.model === server.providers.memoryModel.ref && JSON.stringify(request.messages).includes('<proposed>'))
    .map((request) => JSON.stringify(request.messages))

/** 04:00 in Paris (UTC+1 from October 25th, 2026) on `date`. */
const fourAm = (date: string) => new Date(`${date}T03:00:00Z`)

describe('memory consolidation', () => {
  it("runs at 04:00 in the owner's time zone, only for scopes that changed since its last run", async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Rex deploys with ./deploy.sh.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner is called Sam.' })
    server.providers.memoryModel.script(says('NONE'), says('NONE'))

    await server.clock.advanceTo(fourAm('2026-10-29').getTime() - 1)
    expect(consolidationPrompts(server)).toEqual([])
    await server.clock.advance(1)

    const [shared, own] = consolidationPrompts(server)
    expect(consolidationPrompts(server)).toHaveLength(2)
    expect(shared).toContain('<facts scope=\\"shared\\"')
    expect(shared).toContain('The owner is called Sam.')
    expect(shared).not.toContain('Rex deploys')
    expect(own).toContain('<facts scope=\\"bot\\"')
    expect(own).toContain('Rex deploys with ./deploy.sh.')

    // Nothing changed: the next night asks nothing.
    await server.clock.advanceTo(fourAm('2026-10-30'))
    expect(consolidationPrompts(server)).toHaveLength(2)

    // Only shared memory changed: the night after asks for it alone.
    await server.client.sharedMemory.add({ tier: 'profile', text: 'The owner lives in Paris.' })
    server.providers.memoryModel.script(says('NONE'))
    await server.clock.advanceTo(fourAm('2026-10-31'))
    expect(consolidationPrompts(server)).toHaveLength(3)
    expect(consolidationPrompts(server)[2]).toContain('<facts scope=\\"shared\\"')
  })

  it("consolidates shared memory on the default model and a bot's memory on the bot's own", async () => {
    const { server, bot } = await startWithRex({ memoryModel: false })
    await server.client.bots.update({ botId: bot.id, model: 'fake/fake-mini' })
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Rex deploys with ./deploy.sh.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner is called Sam.' })
    const before = server.providers.requests.length
    server.providers.script(says('NONE'), says('NONE'))

    await server.clock.advanceTo(fourAm('2026-10-29'))

    const asked = server.providers.requests.slice(before).map((request) => [request.model, JSON.stringify(request.messages)] as const)
    expect(asked.map(([model]) => model)).toEqual(['fake/fake-model', 'fake/fake-mini'])
    expect(asked[0]![1]).toContain('<facts scope=\\"shared\\"')
    expect(asked[1]![1]).toContain('<facts scope=\\"bot\\"')
  })

  it('merges duplicate shared facts written by two bots into one, once the verification call accepts it', async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', instructions: 'Ana reviews code.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner prefers tabs.' })
    await updateState(server, ana, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner indents with tabs.', importance: 4 })
    server.providers.memoryModel.script(says('merge [1] [2]: The owner indents with tabs, which they prefer.'), says('1 accept'))

    await server.clock.advanceTo(fourAm('2026-10-29'))

    expect(await server.client.sharedMemory.list()).toMatchObject([
      { id: 1, tier: 'profile', importance: 4, content: 'The owner indents with tabs, which they prefer.', sourceBotName: 'Rex' },
    ])
    const [verification] = verificationPrompts(server)
    expect(verification).toContain('1. merge [1] [2] into [1] (profile, 4): The owner indents with tabs, which they prefer.')
    expect(verification).toContain('[2] (profile, 4, learned 2026-10-28, from Ana) The owner indents with tabs.')
  })

  it('applies none of the changes the verification call rejects', async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner prefers tabs.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner has a dog named Rufus.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'log', text: 'The owner moved to Paris.' })
    server.providers.memoryModel.script(
      says('merge [1] [2]: The owner prefers tabs.\nedit [3] profile'),
      says('1 reject: the dog is lost\n2 accept'),
    )

    await server.clock.advanceTo(fourAm('2026-10-29'))

    expect(await server.client.sharedMemory.list()).toMatchObject([
      { id: 1, content: 'The owner prefers tabs.' },
      { id: 2, content: 'The owner has a dog named Rufus.' },
      { id: 3, tier: 'profile', content: 'The owner moved to Paris.' },
    ])
  })

  it('applies only the changes the verification call accepts, and no second change to a fact', async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', instructions: 'Ana reviews code.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner prefers tabs.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner indents with tabs.' })
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'log', text: 'Rex deploys on Fridays.' })
    server.providers.memoryModel.script(
      says('merge [1] [2]: The owner indents with tabs, which they prefer.'),
      says('1 accept'),
      says('edit [3] profile 4\nremove [3]'),
      says('1 reject: deploying is a habit, not always true'),
    )

    await server.clock.advanceTo(fourAm('2026-10-29'))

    expect(await server.client.sharedMemory.list()).toMatchObject([{ content: 'The owner indents with tabs, which they prefer.' }])
    // Rex's: the removal of a fact the edit already changes is never proposed, and the edit is rejected.
    expect(verificationPrompts(server)).toHaveLength(2)
    expect(verificationPrompts(server)[1]).not.toContain('remove')
    expect(await server.client.bots.memory({ botId: ana.id })).toEqual([])
    expect(await server.client.bots.memory({ botId: bot.id })).toMatchObject([{ id: 3, tier: 'log' }])
  })

  it('deletes notes learned more than 7 days ago, in every scope, changed or not', async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'note', text: 'The build is red.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'note', text: 'The owner is on holiday this week.' })
    // The first night consolidates both scopes, the second Rex's, changed since; nothing changes after.
    server.providers.memoryModel.script(says('NONE'), says('NONE'), says('NONE'))
    await server.clock.advance(day)
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'note', text: 'The build is green.' })

    await server.clock.advanceTo(fourAm('2026-11-04'))
    expect(await server.client.bots.memory({ botId: bot.id })).toHaveLength(2)
    expect(await server.client.sharedMemory.list()).toHaveLength(1)
    await server.clock.advanceTo(fourAm('2026-11-05'))

    expect(await server.client.bots.memory({ botId: bot.id })).toMatchObject([{ content: 'The build is green.' }])
    expect(await server.client.sharedMemory.list()).toEqual([])
  })

  it("never touches facts outside the scope it works on: another bot's, or shared memory from a bot's", async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', instructions: 'Ana reviews code.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner prefers tabs.' })
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Rex deploys with ./deploy.sh.' })
    await updateState(server, ana, { action: 'write', scope: 'bot', tier: 'profile', text: 'Ana reviews every pull request.' })
    server.providers.memoryModel.script(
      // Shared memory: a bot's fact.
      says('remove [2]\nmerge [1] [3]: The owner prefers tabs.'),
      // Rex's: a shared fact, and Ana's.
      says('remove [1]\nedit [3]: Ana reviews nothing.\nmerge [2] [3]: Rex deploys.'),
      // Ana's: Rex's.
      says('remove [2]'),
    )

    await server.clock.advanceTo(fourAm('2026-10-29'))

    expect(verificationPrompts(server)).toEqual([])
    expect(await server.client.sharedMemory.list()).toMatchObject([{ id: 1, content: 'The owner prefers tabs.' }])
    expect(await server.client.bots.memory({ botId: bot.id })).toMatchObject([{ id: 2, content: 'Rex deploys with ./deploy.sh.' }])
    expect(await server.client.bots.memory({ botId: ana.id })).toMatchObject([{ id: 3, content: 'Ana reviews every pull request.' }])
  })

  it('tries a failed call once more, then leaves the scope for the next night', async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner prefers tabs.' })
    server.providers.memoryModel.script(fails('The memory model is down'), fails('The memory model is still down'))

    await server.clock.advanceTo(fourAm('2026-10-29'))
    expect(consolidationPrompts(server)).toHaveLength(2)
    expect(await server.client.sharedMemory.list()).toMatchObject([{ content: 'The owner prefers tabs.' }])

    server.providers.memoryModel.script(says('NONE'))
    await server.clock.advanceTo(fourAm('2026-10-30'))
    expect(consolidationPrompts(server)).toHaveLength(3)
  })

  it("consolidates a bot's unchanged memory once shared memory changed, to remove its facts a newer shared one contradicts", async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'The owner deploys on Fridays.' })
    server.providers.memoryModel.script(says('NONE'))
    await server.clock.advanceTo(fourAm('2026-10-29'))

    await server.clock.advance(day / 2)
    await server.client.sharedMemory.add({ tier: 'profile', text: 'The owner never deploys on Fridays any more.' })
    server.providers.memoryModel.script(says('NONE'), says('remove [1]'), says('1 accept'))
    await server.clock.advanceTo(fourAm('2026-10-30'))

    expect(consolidationPrompts(server).at(-1)).toContain('<shared>\\n- [2] (profile, 3, learned 2026-10-29, from the owner) The owner never deploys on Fridays any more.')
    expect(await server.client.bots.memory({ botId: bot.id })).toEqual([])
  })

  it('leaves a change to a fact edited while the memory model was answering', async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner prefers tabs.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner indents with tabs.' })
    const verdict = held(says('1 accept'))
    server.providers.memoryModel.script(says('merge [1] [2]: The owner prefers tabs and indents with them.'), verdict)

    const night = server.clock.advanceTo(fourAm('2026-10-29'))
    await verdict.requested
    await server.client.sharedMemory.edit({ factId: 1, text: 'The owner prefers spaces now.' })
    verdict.release()
    await night

    expect(await server.client.sharedMemory.list()).toMatchObject([
      { id: 1, content: 'The owner prefers spaces now.' },
      { id: 2, content: 'The owner indents with tabs.' },
    ])
  })
})
