import { callsTools, endsSilently, fails, held } from '@openbot/agent/testing'
import type { BotInfo, NewBot, StampedEvent } from '@openbot/api-contract'
import { routineRuns } from '@openbot/db'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer, type TestServerOptions } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = {
  name: 'Rex',
  title: 'Builder',
  instructions: 'Rex fixes builds.',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
}

const minute = 60 * 1000
const hour = 60 * minute

/** A finished onboarding with Rex, the owner in Paris, on a clock that starts at noon UTC on Wednesday 2026-10-28. */
async function startWithRex(options: TestServerOptions = {}) {
  const server = await createTestServer({ now: new Date('2026-10-28T12:00:00Z'), ...options })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  await server.client.general.updateSettings({ timeZone: 'Europe/Paris' })
  const bot = await server.client.bots.create(rex)
  return { server, bot }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** The last message the model read in each of the bot's requests, past its instructions' updates. */
function readByBot(server: TestServer) {
  return server.providers.requests.map((request) => JSON.stringify(request.messages.filter((message) => message.role !== 'system').at(-1)?.content))
}

/** The routine's runs as the owner sees them, oldest first, without ids. */
async function history(server: TestServer, bot: BotInfo, routineId: string) {
  const runs = await server.client.routines.runs({ botId: bot.id, routineId })
  return runs.reverse().map(({ id: _id, routineId: _routine, ...run }) => run)
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

describe('the owner manages routines', () => {
  it('creates, lists, edits, pauses, resumes and deletes a routine', async () => {
    const { server, bot } = await startWithRex()

    const created = await server.client.routines.create({ botId: bot.id, name: ' Morning digest ', prompt: 'Send me a digest.', schedule: '0 8 * * 1-5' })

    expect(created).toMatchObject({ botId: bot.id, name: 'Morning digest', prompt: 'Send me a digest.', schedule: '0 8 * * 1-5', enabled: true, createdBy: 'owner', running: false })
    // 08:00 in Paris, on Thursday.
    expect(iso(created.nextRunAt)).toBe('2026-10-29T07:00:00.000Z')
    expect(await server.client.routines.list({ botId: bot.id })).toEqual([created])

    const edited = await server.client.routines.update({ botId: bot.id, routineId: created.id, schedule: '@every 30m' })
    expect(edited.schedule).toBe('@every 30m')
    expect(iso(edited.nextRunAt)).toBe('2026-10-28T12:30:00.000Z')

    const paused = await server.client.routines.pause({ botId: bot.id, routineId: created.id })
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null })
    await server.clock.advance(hour)
    const resumed = await server.client.routines.resume({ botId: bot.id, routineId: created.id })
    expect(resumed.enabled).toBe(true)
    expect(iso(resumed.nextRunAt)).toBe('2026-10-28T13:30:00.000Z')
    expect(await history(server, bot, created.id)).toEqual([])

    await server.client.routines.delete({ botId: bot.id, routineId: created.id })
    expect(await server.client.routines.list({ botId: bot.id })).toEqual([])
    await expect(server.client.routines.runs({ botId: bot.id, routineId: created.id })).rejects.toThrow('No such routine')
  })

  it.each([
    [{ name: '', prompt: 'Hi', schedule: '@daily' }, /needs a name/],
    [{ name: 'Digest', prompt: ' ', schedule: '@daily' }, /needs an instruction/],
    [{ name: 'Digest', prompt: 'Hi', schedule: '0 25 * * *' }, /hour/],
    [{ name: 'Digest', prompt: 'Hi', schedule: '@every 4m' }, /at least 5 minutes/],
    [{ name: 'Digest', prompt: 'Hi', schedule: 'at 2026-10-28T09:00' }, /That time has passed/],
  ])('refuses %j', async (values, message) => {
    const { server, bot } = await startWithRex()

    await expect(server.client.routines.create({ botId: bot.id, ...values })).rejects.toThrow(message)
    expect(await server.client.routines.list({ botId: bot.id })).toEqual([])
  })

  it('allows at most 20 routines per bot', async () => {
    const { server, bot } = await startWithRex()
    for (let i = 0; i < 20; i++) await server.client.routines.create({ botId: bot.id, name: `Routine ${i}`, prompt: 'Hi', schedule: '@daily' })

    await expect(server.client.routines.create({ botId: bot.id, name: 'One more', prompt: 'Hi', schedule: '@daily' })).rejects.toThrow(/at most 20 routines/)
    expect(await server.client.routines.list({ botId: bot.id })).toHaveLength(20)
  })

  it("reaches a routine only through its own bot's pane", async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Digest', prompt: 'Hi', schedule: '@daily' })

    const asAna = { botId: ana.id, routineId: routine.id }
    await expect(server.client.routines.update({ ...asAna, name: 'Mine' })).rejects.toThrow('No such routine')
    await expect(server.client.routines.pause(asAna)).rejects.toThrow('No such routine')
    await expect(server.client.routines.delete(asAna)).rejects.toThrow('No such routine')
    await expect(server.client.routines.testRun(asAna)).rejects.toThrow('No such routine')
    await expect(server.client.routines.runs(asAna)).rejects.toThrow('No such routine')
    expect(await server.client.routines.list({ botId: ana.id })).toEqual([])
    expect((await server.client.routines.list({ botId: bot.id }))[0]).toMatchObject({ name: 'Digest', enabled: true })
  })

  it('tells every tab of routine changes and runs', async () => {
    const { server, bot } = await startWithRex()
    const controller = new AbortController()
    const stream = await server.client.events(undefined, { signal: controller.signal })
    await stream.next() // hello
    server.providers.script(endsSilently())

    const routine = await server.client.routines.create({ botId: bot.id, name: 'Digest', prompt: 'Hi', schedule: '@daily' })
    await server.client.routines.testRun({ botId: bot.id, routineId: routine.id })
    await untilIdle(server, bot)
    await server.client.routines.delete({ botId: bot.id, routineId: routine.id })

    const seen: string[] = []
    while (!seen.includes('routine.deleted')) {
      const { value } = (await stream.next()) as { value: StampedEvent }
      const { event } = value
      if (event.type === 'routine.updated') seen.push(`routine.updated${event.routine.running ? ' (running)' : ''}`)
      if (event.type === 'routineRun.updated') seen.push(`run ${event.run.status}`)
      if (event.type === 'routine.deleted') seen.push(event.type)
    }
    controller.abort()
    expect(seen).toEqual(['routine.updated', 'run running', 'routine.updated (running)', 'run ran', 'routine.updated', 'routine.deleted'])
  })
})

describe('a routine fires', () => {
  it("at its local time, waking the bot in the background with the owner's cue, the prompt, when it was due and how late", async () => {
    const { server, bot } = await startWithRex()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Morning digest', prompt: 'Send me a digest.', schedule: '0 8 * * *' })
    server.providers.script(callsTools(['sendMessage', { text: 'Your digest.' }]), endsSilently())

    await server.clock.advanceTo(new Date('2026-10-29T06:59:00Z'))
    expect(server.providers.requests).toHaveLength(0)
    await server.clock.advanceTo(new Date('2026-10-29T07:00:00Z'))
    await untilIdle(server, bot)

    const [read] = readByBot(server)
    expect(read).toContain('[routine \\"Morning digest\\", set by you]')
    expect(read).toContain('Send me a digest.')
    expect(read).toContain('due at 2026-10-29 08:00 (Europe/Paris); this run is on time')
    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    const sent = messages.find((message) => message.text === 'Your digest.')!
    await expect.poll(() => history(server, bot, routine.id)).toEqual([
      {
        scheduledFor: Date.parse('2026-10-29T07:00:00Z'),
        firedAt: Date.parse('2026-10-29T07:00:00Z'),
        status: 'ran',
        finishedAt: Date.parse('2026-10-29T07:00:00Z'),
        message: { id: sent.id, chatId: bot.chatId },
        test: false,
      },
    ])
    expect(iso((await server.client.routines.list({ botId: bot.id }))[0]!.nextRunAt)).toBe('2026-10-30T07:00:00.000Z')
  })

  it('may stay silent: its run records no message and the owner is not reminded', async () => {
    const { server, bot } = await startWithRex()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Check', prompt: 'Check the build.', schedule: '@every 15m' })
    server.providers.script(endsSilently())

    await server.clock.advance(15 * minute)
    await untilIdle(server, bot)

    await expect.poll(async () => (await history(server, bot, routine.id)).map((run) => [run.status, run.message])).toEqual([['ran', null]])
    expect(server.providers.requests).toHaveLength(1)
    expect(await server.client.chats.messages({ chatId: bot.chatId })).toEqual([])
  })

  it("wakes the bot with its own note's cue for a routine it wrote, and the owner's once the owner edits it", async () => {
    const { server, bot } = await startWithRex()
    // As the bot's own update_state does; no procedure creates a bot's routine.
    const routine = await server.routines.create(bot.id, { name: 'Tidy', prompt: 'Tidy your folder.', schedule: '@every 15m' }, 'bot')
    expect((await server.client.routines.list({ botId: bot.id }))[0]!.createdBy).toBe('bot')
    server.providers.script(endsSilently(), endsSilently())

    await server.clock.advance(15 * minute)
    await untilIdle(server, bot)
    const edited = await server.client.routines.update({ botId: bot.id, routineId: routine.id, prompt: 'Tidy your folder and the shared one.' })
    await server.clock.advance(15 * minute)
    await untilIdle(server, bot)

    expect(edited.createdBy).toBe('owner')
    const [first, second] = readByBot(server)
    expect(first).toContain('[routine \\"Tidy\\", your own note]')
    expect(second).toContain('[routine \\"Tidy\\", set by you]')
    expect(second).toContain('Tidy your folder and the shared one.')
  })

  it('moves to its new local time when the owner changes time zone; a reminder keeps its wall-clock time', async () => {
    const { server, bot } = await startWithRex()
    const daily = await server.client.routines.create({ botId: bot.id, name: 'Daily', prompt: 'Daily.', schedule: '0 8 * * *' })
    const reminder = await server.client.routines.create({ botId: bot.id, name: 'Dentist', prompt: 'Remind me of the dentist.', schedule: 'at 2026-10-29T09:00' })
    expect(iso(daily.nextRunAt)).toBe('2026-10-29T07:00:00.000Z')
    expect(iso(reminder.nextRunAt)).toBe('2026-10-29T08:00:00.000Z')

    await server.client.general.updateSettings({ timeZone: 'America/New_York' })
    await expect
      .poll(async () => (await server.client.routines.list({ botId: bot.id })).map((routine) => iso(routine.nextRunAt)))
      .toEqual(['2026-10-29T12:00:00.000Z', '2026-10-29T13:00:00.000Z'])

    server.providers.script(endsSilently(), endsSilently())
    await server.clock.advanceTo(new Date('2026-10-29T12:00:00Z'))
    await untilIdle(server, bot)
    expect(server.providers.requests).toHaveLength(1)
    expect(readByBot(server)[0]).toContain('due at 2026-10-29 08:00 (America/New_York)')
    await server.clock.advanceTo(new Date('2026-10-29T13:00:00Z'))
    await untilIdle(server, bot)
    expect(server.providers.requests).toHaveLength(2)
    expect(readByBot(server)[1]).toContain('Remind me of the dentist.')
  })

  it('as a reminder, once: it is then disabled, kept with its history', async () => {
    const { server, bot } = await startWithRex()
    const reminder = await server.client.routines.create({ botId: bot.id, name: 'Dentist', prompt: 'Remind me of the dentist.', schedule: 'at 2026-10-28T14:00' })
    server.providers.script(endsSilently())

    await server.clock.advanceTo(new Date('2026-10-28T13:00:00Z'))
    await untilIdle(server, bot)
    await server.clock.advance(24 * hour)

    expect(server.providers.requests).toHaveLength(1)
    expect(await server.client.routines.list({ botId: bot.id })).toEqual([expect.objectContaining({ id: reminder.id, enabled: false, nextRunAt: null })])
    await expect.poll(async () => (await history(server, bot, reminder.id)).map((run) => run.status)).toEqual(['ran'])
    await expect(server.client.routines.resume({ botId: bot.id, routineId: reminder.id })).rejects.toThrow(/That time has passed/)
  })

  it('is skipped while its previous run is still queued or running', async () => {
    const { server, bot } = await startWithRex()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Check', prompt: 'Check the build.', schedule: '@every 15m' })
    const slow = held(endsSilently())
    server.providers.script(slow)

    await server.clock.advance(15 * minute)
    await slow.requested
    await server.clock.advance(15 * minute)
    const skipped = await server.client.routines.testRun({ botId: bot.id, routineId: routine.id })
    slow.release()
    await untilIdle(server, bot)

    expect(skipped).toMatchObject({ status: 'skipped_overlap', test: true, firedAt: null })
    await expect.poll(async () => (await history(server, bot, routine.id)).map((run) => [run.status, iso(run.scheduledFor)])).toEqual([
      ['ran', '2026-10-28T12:15:00.000Z'],
      ['skipped_overlap', '2026-10-28T12:30:00.000Z'],
      ['skipped_overlap', '2026-10-28T12:30:00.000Z'],
    ])
    expect(iso((await server.client.routines.list({ botId: bot.id }))[0]!.nextRunAt)).toBe('2026-10-28T12:45:00.000Z')
  })

  it('records a failed run, with an audit entry and nothing in the DM', async () => {
    const { server, bot } = await startWithRex()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Check', prompt: 'Check the build.', schedule: '@every 15m' })
    server.providers.script(fails('The provider is down'))

    await server.clock.advance(15 * minute)
    await untilIdle(server, bot)

    await expect.poll(async () => (await history(server, bot, routine.id)).map((run) => run.status)).toEqual(['failed'])
    const audit = await server.client.bots.audit({ botId: bot.id })
    expect(audit).toEqual([
      expect.objectContaining({ kind: 'routine', surface: 'routine_change', tool: 'routine', input: expect.objectContaining({ routineId: routine.id, name: 'Check', status: 'failed', error: expect.stringContaining('The provider is down') }) }),
    ])
    expect(await server.client.chats.messages({ chatId: bot.chatId })).toEqual([])
  })

  it('fires now on Test run, paused or not, without moving its next run', async () => {
    const { server, bot } = await startWithRex()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Digest', prompt: 'Send me a digest.', schedule: '0 8 * * *' })
    await server.client.routines.pause({ botId: bot.id, routineId: routine.id })
    server.providers.script(endsSilently())

    const run = await server.client.routines.testRun({ botId: bot.id, routineId: routine.id })
    await untilIdle(server, bot)

    expect(run).toMatchObject({ status: 'running', test: true, scheduledFor: Date.parse('2026-10-28T12:00:00Z') })
    expect(readByBot(server)[0]).toContain('as a test')
    expect(await server.client.routines.list({ botId: bot.id })).toEqual([expect.objectContaining({ enabled: false, nextRunAt: null })])
    await expect.poll(async () => (await history(server, bot, routine.id)).map((entry) => entry.status)).toEqual(['ran'])
  })

  it('keeps the last 100 runs, and an older one until it ends', async () => {
    const { server, bot } = await startWithRex()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Check', prompt: 'Check the build.', schedule: '@every 15m' })
    // Each fire overlaps the first, which doesn't end until released, and is skipped.
    const stuck = held(endsSilently())
    server.providers.script(stuck)
    await server.clock.advance(15 * minute)
    await stuck.requested

    await server.clock.advance(101 * 15 * minute)

    const runs = await server.client.routines.runs({ botId: bot.id, routineId: routine.id })
    expect(runs).toHaveLength(101)
    expect(runs.slice(0, 100).every((run) => run.status === 'skipped_overlap')).toBe(true)
    expect([iso(runs[0]!.scheduledFor), iso(runs[99]!.scheduledFor)]).toEqual(['2026-10-29T13:30:00.000Z', '2026-10-28T12:45:00.000Z'])
    expect(runs[100]).toMatchObject({ status: 'running', scheduledFor: Date.parse('2026-10-28T12:15:00Z') })

    stuck.release()
    await untilIdle(server, bot)
    await expect.poll(async () => (await server.client.routines.runs({ botId: bot.id, routineId: routine.id })).at(-1)?.status).toBe('ran')
    server.providers.script(endsSilently())
    await server.clock.advance(15 * minute)
    await untilIdle(server, bot)
    await expect.poll(async () => (await server.client.routines.runs({ botId: bot.id, routineId: routine.id })).map((run) => run.status).slice(0, 1)).toEqual(['ran'])
    expect(await server.client.routines.runs({ botId: bot.id, routineId: routine.id })).toHaveLength(100)
  })
})

describe('fires missed while the server was down', () => {
  it('run once if under an hour late, several collapsing into one', async () => {
    const { server: before, bot } = await startWithRex()
    const routine = await before.client.routines.create({ botId: bot.id, name: 'Check', prompt: 'Check the build.', schedule: '0 * * * *' })
    await before.shutdown()
    // Down from 12:00 to 15:20: the fires at 13:00, 14:00 and 15:00 were missed; 15:00 is 20 minutes late.
    await before.kept.clock.advanceTo(new Date('2026-10-28T15:20:00Z'))

    const after = await restartTestServer(before, { script: (providers) => providers.script(endsSilently()) })
    servers.splice(servers.indexOf(before), 1, after)
    await untilIdle(after, bot)

    expect(after.providers.requests).toHaveLength(1)
    expect(readByBot(after)[0]).toContain('due at 2026-10-28 16:00 (Europe/Paris); this run is 20 minutes late')
    await expect.poll(async () => (await history(after, bot, routine.id)).map((run) => [run.status, iso(run.scheduledFor)])).toEqual([['ran', '2026-10-28T15:00:00.000Z']])
    expect(iso((await after.client.routines.list({ botId: bot.id }))[0]!.nextRunAt)).toBe('2026-10-28T16:00:00.000Z')
  })

  it('of an @every routine collapse into the latest due, from its own start', async () => {
    const { server: before, bot } = await startWithRex()
    const routine = await before.client.routines.create({ botId: bot.id, name: 'Check', prompt: 'Check the build.', schedule: '@every 25m' })
    await before.shutdown()
    // Due at 12:25, 12:50, …, 15:20; down until 15:30.
    await before.kept.clock.advanceTo(new Date('2026-10-28T15:30:00Z'))

    const after = await restartTestServer(before, { script: (providers) => providers.script(endsSilently()) })
    servers.splice(servers.indexOf(before), 1, after)
    await untilIdle(after, bot)

    await expect.poll(async () => (await history(after, bot, routine.id)).map((run) => [run.status, iso(run.scheduledFor)])).toEqual([['ran', '2026-10-28T15:20:00.000Z']])
    expect(iso((await after.client.routines.list({ botId: bot.id }))[0]!.nextRunAt)).toBe('2026-10-28T15:55:00.000Z')
  })

  it('are recorded as missed once an hour late or more', async () => {
    const { server: before, bot } = await startWithRex()
    const daily = await before.client.routines.create({ botId: bot.id, name: 'Daily', prompt: 'Daily.', schedule: '0 14 * * *' })
    const reminder = await before.client.routines.create({ botId: bot.id, name: 'Dentist', prompt: 'Dentist.', schedule: 'at 2026-10-28T14:00' })
    await before.shutdown()
    await before.kept.clock.advanceTo(new Date('2026-10-28T14:30:00Z'))

    const after = await restartTestServer(before)
    servers.splice(servers.indexOf(before), 1, after)
    await after.routines.idle()

    expect(after.providers.requests).toHaveLength(0)
    for (const routine of [daily, reminder]) {
      expect((await history(after, bot, routine.id)).map((run) => [run.status, iso(run.scheduledFor), run.firedAt])).toEqual([['missed', '2026-10-28T13:00:00.000Z', null]])
    }
    expect((await after.client.routines.list({ botId: bot.id })).map((routine) => [routine.enabled, iso(routine.nextRunAt)])).toEqual([
      [true, '2026-10-29T13:00:00.000Z'],
      [false, null],
    ])
  })

  it('a run queued when the server stopped runs after it starts again, and its history follows', async () => {
    const { server: before, bot } = await startWithRex()
    const routine = await before.client.routines.create({ botId: bot.id, name: 'Check', prompt: 'Check the build.', schedule: '@every 15m' })
    const stuck = held(endsSilently())
    before.providers.script(stuck)
    await before.clock.advance(15 * minute)
    await stuck.requested

    const after = await restartTestServer(before, { script: (providers) => providers.script(endsSilently()) })
    servers.splice(servers.indexOf(before), 1, after)
    await untilIdle(after, bot)

    await expect.poll(async () => (await history(after, bot, routine.id)).map((run) => run.status)).toEqual(['ran'])
  })
})

describe('deleting a bot', () => {
  it('deletes its routines and their runs', async () => {
    const { server, bot } = await startWithRex()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Check', prompt: 'Check the build.', schedule: '@every 15m' })
    server.providers.script(endsSilently())
    await server.clock.advance(15 * minute)
    await untilIdle(server, bot)
    await expect.poll(async () => (await history(server, bot, routine.id)).length).toBe(1)

    await server.client.bots.delete({ botId: bot.id })
    await server.clock.advance(15 * minute)

    expect(await server.db.select().from(routineRuns)).toEqual([])
    await expect(server.client.routines.list({ botId: bot.id })).rejects.toThrow('No such bot')
    expect(server.providers.requests).toHaveLength(1)
  })
})
