import { callsTools, endsSilently, says } from '@openbot/agent/testing'
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

/** A finished onboarding: the `fake` provider connected, `fake/fake-model` as default, and Rex. */
async function startWithRex(options: TestServerOptions = {}) {
  const server = await createTestServer(options)
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bot = await server.client.bots.create(rex)
  return { server, bot }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** Has the owner say `text` to the bot and waits for its run to end. */
async function chat(server: TestServer, bot: BotInfo, text: string) {
  await server.client.chats.send({ chatId: bot.chatId, text })
  await untilIdle(server, bot)
}

describe('the memory model', () => {
  it("is scripted apart from the bots' model, and requests show which model each call went to", async () => {
    const { server, bot } = await startWithRex({ memoryModel: true })
    // Queued first, yet only the memory model's request takes it.
    server.providers.memoryModel.script(says('- The owner ships on Fridays'))
    server.providers.script(callsTools(['sendMessage', { text: 'Noted!' }]), endsSilently())

    await chat(server, bot, 'We ship on Fridays.')
    const extracted = await server.complete(server.providers.memoryModel.ref, { systemPrompt: 'Extract facts', prompt: 'We ship on Fridays.' })

    expect(extracted).toBe('- The owner ships on Fridays')
    expect(server.providers.requests.map((request) => request.model)).toEqual(['fake/fake-model', 'fake/fake-model', 'fake/fake-memory'])
    expect(server.providers.pendingTurns).toBe(0)
    expect(server.providers.memoryModel.pendingTurns).toBe(0)
  })

  it("isn't listed unless a test asks for it", async () => {
    const { server } = await startWithRex()

    expect((await server.client.models.list()).map((model) => model.ref)).toEqual(['fake/fake-model', 'fake/fake-mini'])
  })
})

describe('compaction', () => {
  /** Rex on a server whose compactions summarize all but the newest entries, so even a short chat compacts. */
  const startCompacting = () => startWithRex({ compaction: { keepRecentTokens: 1 } })

  it("is forced on a bot's history on demand, beginning a new compaction epoch the next run reads from", async () => {
    const { server, bot } = await startCompacting()
    server.providers.script(callsTools(['sendMessage', { text: 'Noted!' }]), endsSilently())
    await chat(server, bot, 'We ship on Fridays.')
    const before = await server.runtime.compactionEpoch(bot.id)

    server.providers.script(says('The owner said they ship on Fridays; Rex noted it.'))
    await server.runtime.compact(bot.id)
    const after = await server.runtime.compactionEpoch(bot.id)
    server.providers.script(callsTools(['sendMessage', { text: 'Friday it is.' }]), endsSilently())
    await chat(server, bot, 'When do we ship?')

    expect(before).toBeNull()
    expect(after).not.toBeNull()
    const next = JSON.stringify(server.providers.requests.at(-2)!.messages)
    expect(next).toContain('The owner said they ship on Fridays; Rex noted it.')
    expect(next).not.toContain('Noted!')
    expect(next).toContain('When do we ship?')
  })

  it('begins another epoch each time it is forced', async () => {
    const { server, bot } = await startCompacting()
    const epochs = []
    for (const text of ['We ship on Fridays.', 'Builds run on main.']) {
      server.providers.script(callsTools(['sendMessage', { text: 'Noted!' }]), endsSilently())
      await chat(server, bot, text)
      server.providers.script(says(`Summary up to: ${text}`))
      await server.runtime.compact(bot.id)
      epochs.push(await server.runtime.compactionEpoch(bot.id))
    }

    expect(epochs[0]).not.toBeNull()
    expect(epochs[1]).not.toBeNull()
    expect(epochs[1]).not.toBe(epochs[0])
  })
})

describe('the clock', () => {
  /** Starts a server whose clock reads `now`. */
  async function startAt(now: string) {
    const server = await createTestServer({ now: new Date(now) })
    servers.push(server)
    return server
  }

  it("fires a daily server job at its local time in the owner's time zone, as the test moves time forward", async () => {
    const server = await startAt('2026-10-28T12:00:00Z')
    const fired: string[] = []
    server.jobs.daily('consolidation', { at: '04:00', timeZone: () => 'America/New_York' }, async () => {
      fired.push(new Date(server.clock.now()).toISOString())
    })

    await server.clock.advance(20 * 60 * 60 * 1000 - 1)
    expect(fired).toEqual([])
    await server.clock.advance(1)
    // 04:00 in New York, four hours behind UTC until daylight saving time ends on November 1st, then five.
    expect(fired).toEqual(['2026-10-29T08:00:00.000Z'])
    await server.clock.advanceTo(new Date('2026-11-02T12:00:00Z'))
    expect(fired).toEqual([
      '2026-10-29T08:00:00.000Z',
      '2026-10-30T08:00:00.000Z',
      '2026-10-31T08:00:00.000Z',
      '2026-11-01T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
    ])
  })

  it('follows the time zone as it is when the job is next scheduled', async () => {
    const server = await startAt('2026-10-28T12:00:00Z')
    let timeZone = 'Europe/Paris'
    const fired: string[] = []
    server.jobs.daily('consolidation', { at: '04:00', timeZone: () => timeZone }, async () => {
      fired.push(new Date(server.clock.now()).toISOString())
      timeZone = 'Asia/Tokyo'
    })

    await server.clock.advanceTo(new Date('2026-10-30T12:00:00Z'))

    // 04:00 in Paris (UTC+1), then 04:00 in Tokyo (UTC+9).
    expect(fired).toEqual(['2026-10-29T03:00:00.000Z', '2026-10-29T19:00:00.000Z'])
  })

  it('keeps firing after a job fails', async () => {
    const server = await startAt('2026-10-28T12:00:00Z')
    let runs = 0
    server.jobs.daily('consolidation', { at: '04:00', timeZone: () => 'UTC' }, async () => {
      runs++
      throw new Error('The memory model is down')
    })

    await server.clock.advanceTo(new Date('2026-10-30T12:00:00Z'))

    expect(runs).toBe(2)
  })

  it('schedules a job whose time zone is unknown in UTC', async () => {
    const server = await startAt('2026-10-28T12:00:00Z')
    const fired: string[] = []
    server.jobs.daily('consolidation', { at: '04:00', timeZone: () => 'Mars/Olympus_Mons' }, async () => {
      fired.push(new Date(server.clock.now()).toISOString())
    })

    await server.clock.advanceTo(new Date('2026-10-30T12:00:00Z'))

    expect(fired).toEqual(['2026-10-29T04:00:00.000Z', '2026-10-30T04:00:00.000Z'])
  })

  it("moves on only once a job's run has finished, however long its I/O takes", async () => {
    const server = await startAt('2026-10-28T12:00:00Z')
    const fired: string[] = []
    server.jobs.daily('consolidation', { at: '04:00', timeZone: () => 'UTC' }, async () => {
      await server.client.bots.list()
      await new Promise((resolve) => setTimeout(resolve, 20))
      fired.push(new Date(server.clock.now()).toISOString())
    })

    await server.clock.advanceTo(new Date('2026-10-30T12:00:00Z'))

    expect(fired).toEqual(['2026-10-29T04:00:00.000Z', '2026-10-30T04:00:00.000Z'])
  })

  it('stops firing once the server shuts down', async () => {
    const server = await startAt('2026-10-28T12:00:00Z')
    let runs = 0
    server.jobs.daily('consolidation', { at: '04:00', timeZone: () => 'UTC' }, async () => {
      runs++
    })

    await server.jobs.close()
    await server.clock.advanceTo(new Date('2026-10-30T12:00:00Z'))

    expect(runs).toBe(0)
  })
})
