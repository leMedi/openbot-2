import { owedReplyNote } from '@openbot/agent'
import { callsTools, endsSilently, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { postMessage } from '@openbot/core'
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

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

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

/** The bot calls `update_state` on its routines with `args`, then ends its run silently; returns what the tool answered. */
async function updateRoutines(server: TestServer, bot: BotInfo, args: Record<string, unknown>) {
  server.providers.script(callsTools(['update_state', { target: 'routine', ...args } as never]), endsSilently())
  await server.runtime.wake(bot.id, { lane: 'background', text: '[test] manage your routines' })
  await untilIdle(server, bot)
  const result = server.providers.requests.at(-1)!.messages.at(-1)!
  return JSON.stringify(result.role === 'toolResult' ? result.content : result)
}

describe('a bot manages its own routines', () => {
  it('creates one, as its own note, enabled, with its next run', async () => {
    const { server, bot } = await startWithRex()

    const answer = await updateRoutines(server, bot, { action: 'create', name: 'Morning digest', prompt: 'Send the owner a digest.', schedule: '0 8 * * 1-5' })

    const [routine] = await server.client.routines.list({ botId: bot.id })
    expect(routine).toMatchObject({ name: 'Morning digest', prompt: 'Send the owner a digest.', schedule: '0 8 * * 1-5', enabled: true, createdBy: 'bot' })
    expect(iso(routine!.nextRunAt)).toBe('2026-10-29T07:00:00.000Z')
    expect(answer).toContain(`Created routine [${routine!.id}] \\"Morning digest\\"; next run 2026-10-29 08:00 (Europe/Paris).`)
  })

  it('updates, pauses, resumes and deletes one; its update makes an owner\'s routine its own note', async () => {
    const { server, bot } = await startWithRex()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Digest', prompt: 'Send me a digest.', schedule: '0 8 * * *' })

    expect(await updateRoutines(server, bot, { action: 'update', routineId: routine.id, schedule: '@every 30m' })).toContain(`Updated routine [${routine.id}]; next run 2026-10-28 13:30`)
    expect((await server.client.routines.list({ botId: bot.id }))[0]).toMatchObject({ schedule: '@every 30m', createdBy: 'bot', name: 'Digest' })

    expect(await updateRoutines(server, bot, { action: 'pause', routineId: routine.id })).toContain(`Paused routine [${routine.id}].`)
    expect((await server.client.routines.list({ botId: bot.id }))[0]).toMatchObject({ enabled: false, nextRunAt: null })

    expect(await updateRoutines(server, bot, { action: 'pause', routineId: routine.id })).toContain(`Routine [${routine.id}] is already paused.`)

    await server.clock.advance(60 * 60 * 1000)
    expect(await updateRoutines(server, bot, { action: 'resume', routineId: routine.id })).toContain(`Resumed routine [${routine.id}]; next run 2026-10-28 14:30`)
    expect(await updateRoutines(server, bot, { action: 'resume', routineId: routine.id })).toContain(`Routine [${routine.id}] is already on.`)
    expect((await server.client.routines.list({ botId: bot.id }))[0]).toMatchObject({ enabled: true })

    expect(await updateRoutines(server, bot, { action: 'delete', routineId: routine.id })).toContain(`Deleted routine [${routine.id}].`)
    expect(await server.client.routines.list({ botId: bot.id })).toEqual([])
    // A pause or resume that changed nothing posted no row.
    expect((await server.client.chats.messages({ chatId: bot.chatId })).map((message) => message.card?.type === 'routine_change' && message.card.change)).toEqual([
      'updated',
      'paused',
      'resumed',
      'deleted',
    ])
  })

  it('applies the limits: at most 20 routines, a valid schedule, a name and a prompt', async () => {
    const { server, bot } = await startWithRex()

    expect(await updateRoutines(server, bot, { action: 'create', name: 'Fast', prompt: 'Check.', schedule: '@every 1m' })).toContain('at least 5 minutes')
    expect(await updateRoutines(server, bot, { action: 'create', name: 'Late', prompt: 'Check.', schedule: 'at 2026-10-28T09:00' })).toContain('That time has passed')
    expect(await updateRoutines(server, bot, { action: 'create', name: 'Vague', schedule: '@daily' })).toContain('needs a name, a prompt and a schedule')
    for (let i = 0; i < 20; i++) await server.client.routines.create({ botId: bot.id, name: `Routine ${i}`, prompt: 'Hi', schedule: '@daily' })
    expect(await updateRoutines(server, bot, { action: 'create', name: 'One more', prompt: 'Hi', schedule: '@daily' })).toContain('at most 20 routines')

    expect(await server.client.routines.list({ botId: bot.id })).toHaveLength(20)
  })

  it("can't see or touch another bot's routines: their ids answer as missing ones do, and they stay as they were", async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })
    const anas = await server.client.routines.create({ botId: ana.id, name: "Ana's digest", prompt: 'Digest.', schedule: '@daily' })
    const missing = '01900000-0000-7000-8000-000000000000'

    for (const action of ['update', 'pause', 'resume', 'delete']) {
      const args = { action, ...(action === 'update' && { name: 'Mine now' }) }
      const foreign = await updateRoutines(server, bot, { ...args, routineId: anas.id })
      const unknown = await updateRoutines(server, bot, { ...args, routineId: missing })
      expect(foreign).toContain(`There is no routine [${anas.id}] of yours.`)
      expect(foreign.replace(anas.id, '…')).toBe(unknown.replace(missing, '…'))
    }

    expect(await server.client.routines.list({ botId: ana.id })).toEqual([anas])
    expect(await server.client.routines.list({ botId: bot.id })).toEqual([])
    expect((await server.client.chats.messages({ chatId: bot.chatId })).map((message) => message.text)).toEqual([])
  })
})

describe("a bot's changes to its routines", () => {
  it('are reviewed and audited as routine_change', async () => {
    const { server, bot } = await startWithRex()
    await updateRoutines(server, bot, { action: 'create', name: 'Digest', prompt: 'Send me a digest.', schedule: '@daily' })
    const [routine] = await server.client.routines.list({ botId: bot.id })
    await updateRoutines(server, bot, { action: 'pause', routineId: routine!.id })

    expect(await server.client.bots.audit({ botId: bot.id })).toMatchObject([
      {
        kind: 'action',
        surface: 'routine_change',
        tool: 'update_state',
        input: { target: 'routine', action: 'create', name: 'Digest', prompt: 'Send me a digest.', schedule: '@daily' },
        verdict: { decision: 'allow' },
      },
      { kind: 'action', surface: 'routine_change', input: { target: 'routine', action: 'pause', routineId: routine!.id }, verdict: { decision: 'allow' } },
    ])
  })

  it('are not made when the orchestrator blocks them', async () => {
    const { server, bot } = await startWithRex({ orchestrator: { review: async () => ({ decision: 'deny', reason: 'the owner never asked' }) } })
    await server.client.orchestrator.updateModes({ routine_change: 'enforce' })

    expect(await updateRoutines(server, bot, { action: 'create', name: 'Spam', prompt: 'Message the owner.', schedule: '@every 5m' })).toContain('the owner never asked')

    expect(await server.client.routines.list({ botId: bot.id })).toEqual([])
    expect(await server.client.chats.messages({ chatId: bot.chatId })).toEqual([])
  })

  it("post a timeline row in the bot's DM for each, naming the routine", async () => {
    const { server, bot } = await startWithRex()
    await updateRoutines(server, bot, { action: 'create', name: 'Morning digest', prompt: 'Send me a digest.', schedule: '0 8 * * 1-5' })
    const [routine] = await server.client.routines.list({ botId: bot.id })
    for (const action of ['pause', 'resume']) await updateRoutines(server, bot, { action, routineId: routine!.id })
    await updateRoutines(server, bot, { action: 'update', routineId: routine!.id, name: 'Weekday digest' })
    await updateRoutines(server, bot, { action: 'delete', routineId: routine!.id })

    const messages = await server.client.chats.messages({ chatId: bot.chatId })
    expect(messages.map(({ author, authorName, text, card }) => ({ author, authorName, text, card }))).toEqual(
      [
        ['created', 'Morning digest'],
        ['paused', 'Morning digest'],
        ['resumed', 'Morning digest'],
        ['changed', 'Weekday digest'],
        ['deleted', 'Weekday digest'],
      ].map(([verb, name]) => ({
        author: 'bot',
        authorName: 'Rex',
        text: `Rex ${verb} routine *${name}*`,
        card: { type: 'routine_change', change: verb === 'changed' ? 'updated' : verb, routineId: routine!.id, name },
      })),
    )
  })

  it("aren't the bot's reply: a bot that owes the owner one still owes it", async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(
      callsTools(['update_state', { target: 'routine', action: 'create', name: 'Digest', prompt: 'Digest.', schedule: '@daily' }]),
      endsSilently(),
      callsTools(['sendMessage', { text: 'Done: a daily digest.' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: bot.chatId, text: 'Send me a digest every day.' })
    await untilIdle(server, bot)

    // The reply guarantee read past the timeline row: the bot was reminded, and replied.
    expect(server.providers.requests).toHaveLength(4)
    expect((await server.client.chats.messages({ chatId: bot.chatId })).map((message) => message.text)).toEqual([
      'Send me a digest every day.',
      'Rex created routine *Digest*',
      'Done: a daily digest.',
    ])
  })

  it("aren't the bot's reply across a restart either: the owner's message before one is still the one owed", async () => {
    const { server: before, bot } = await startWithRex()
    // The server stopped right after the bot noted a routine change, while it owed the owner a reply.
    await postMessage(before.db, { chatId: bot.chatId, author: 'owner', authorName: 'You', text: 'Send me a digest every day.' })
    await postMessage(before.db, {
      chatId: bot.chatId,
      author: 'bot',
      authorBotId: bot.id,
      authorName: 'Rex',
      text: 'Rex created routine *Digest*',
      card: { type: 'routine_change', change: 'created', routineId: 'r1', name: 'Digest' },
      idempotencyKey: 'row',
    })

    const after = await restartTestServer(before, {
      script: (providers) => providers.script(callsTools(['sendMessage', { text: 'Done: a daily digest.' }]), endsSilently()),
    })
    servers.splice(servers.indexOf(before), 1, after)
    await expect.poll(async () => (await after.client.chats.messages({ chatId: bot.chatId })).at(-1)?.text).toBe('Done: a daily digest.')

    const woken = JSON.stringify(after.providers.requests[0]!.messages.at(-1))
    expect(woken).toContain(owedReplyNote)
    expect(woken).toContain('Send me a digest every day.')
  })
})

describe('the routines block', () => {
  /** Compacts the bot's history, as pi-durable does near the context window. */
  async function compact(server: TestServer, bot: BotInfo) {
    server.providers.script(says('Summary so far.'))
    await server.runtime.compact(bot.id)
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

  /**
   * The bot's prompt as its next run has it: its system messages replayed in order, later ones replacing sections by
   * name (as pi-ai providers do), so a section changed since reads only as it is now.
   */
  async function currentPrompt(server: TestServer, bot: BotInfo) {
    server.providers.script(endsSilently())
    await server.runtime.wake(bot.id, { lane: 'background', text: '[test] look around' })
    await untilIdle(server, bot)
    const content: string[] = []
    const sections = new Map<string, string>()
    for (const message of server.providers.requests.at(-1)!.messages) {
      if (message.role !== 'system') continue
      content.push(typeof message.content === 'string' ? message.content : message.content.map((part) => part.text).join(''))
      for (const [name, text] of Object.entries(message.sections ?? {})) {
        if (text === null) sections.delete(name)
        else sections.set(name, text)
      }
    }
    return [...content, ...sections.values()].join('\n')
  }

  const startCompacting = () => startWithRex({ compaction: { keepRecentTokens: 1 } })

  it("lists the bot's own new routine from its next compaction epoch, with its schedule in words and next run", async () => {
    const { server, bot } = await startCompacting()
    expect(await nextPrompt(server, bot)).not.toContain('<routines>')

    await updateRoutines(server, bot, { action: 'create', name: 'Morning digest', prompt: 'Send the owner a digest.', schedule: '0 8 * * 1-5' })
    const [routine] = await server.client.routines.list({ botId: bot.id })
    expect(await nextPrompt(server, bot)).not.toContain('<routines>')

    await compact(server, bot)
    const prompt = await nextPrompt(server, bot)
    expect(prompt).toContain('<routines>')
    expect(prompt).toContain(`- [${routine!.id}] Morning digest (your own note): every weekday at 08:00; next run 2026-10-29 08:00`)
    // Next to the memory block, before it.
    await server.client.bots.addFact({ botId: bot.id, tier: 'profile', text: 'Rex likes tidy logs.' })
    const withMemory = await nextPrompt(server, bot)
    expect(withMemory.indexOf('</routines>')).toBeLessThan(withMemory.indexOf('<memory>'))
  })

  it("shows the owner's changes on the bot's next run, and leaves paused routines out", async () => {
    const { server, bot } = await startCompacting()
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Digest', prompt: 'Digest.', schedule: '@daily' })
    expect(await nextPrompt(server, bot)).toContain(`- [${routine.id}] Digest (set by the owner): every day at 00:00; next run 2026-10-29 00:00`)

    await server.client.routines.update({ botId: bot.id, routineId: routine.id, schedule: '@every 2h' })
    expect(await nextPrompt(server, bot)).toContain(`- [${routine.id}] Digest (set by the owner): every 2 hours; next run 2026-10-28 15:00`)

    await server.client.routines.pause({ botId: bot.id, routineId: routine.id })
    expect(await currentPrompt(server, bot)).not.toContain('<routines>')
  })
})
