import { callsTools, endsSilently, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { memories } from '@openbot/db'
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
 * A finished onboarding with Rex, on a server whose clock starts at noon UTC on 2026-10-28 and whose compactions
 * summarize all but the newest entries, so even a short chat compacts.
 */
async function startWithRex(options: TestServerOptions = {}) {
  const server = await createTestServer({ now: new Date('2026-10-28T12:00:00Z'), compaction: { keepRecentTokens: 1 }, ...options })
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

/** The bot calls `update_state` with `args`, then ends its run silently; returns what the tool answered. */
async function updateState(server: TestServer, bot: BotInfo, args: Record<string, unknown>) {
  server.providers.script(callsTools(['update_state', { target: 'memory', ...args } as never]), endsSilently())
  await server.runtime.wake(bot.id, { lane: 'background', text: '[test] update your memory' })
  await untilIdle(server, bot)
  const result = server.providers.requests.at(-1)!.messages.at(-1)!
  return JSON.stringify(result.role === 'toolResult' ? result.content : result)
}

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

describe('bot memory', () => {
  it('reaches the prompt with its next compaction, and survives it', async () => {
    const { server, bot } = await startWithRex()

    const written = await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'The owner deploys on Fridays.' })
    expect(written).toContain('[1]')
    expect(await nextPrompt(server, bot)).not.toContain('The owner deploys on Fridays.')

    await compact(server, bot)
    expect(await nextPrompt(server, bot)).toContain('- [1] (learned 2026-10-28) The owner deploys on Fridays.')
    await compact(server, bot)
    expect(await nextPrompt(server, bot)).toContain('- [1] (learned 2026-10-28) The owner deploys on Fridays.')
  })

  it('edits a fact in place, keeping its id and the day it was learned', async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'note', text: 'The build is red.' })
    await server.clock.advance(day)

    expect(await updateState(server, bot, { action: 'edit', id: 1, text: 'The build is green again.', tier: 'log' })).toContain('Updated [1]')

    await compact(server, bot)
    const prompt = await nextPrompt(server, bot)
    expect(prompt).toContain('- [1] (learned 2026-10-28) The build is green again.')
    expect(prompt).not.toContain('The build is red.')
  })

  it('forgets a fact for good: its id is never used again', async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'The owner likes tabs.' })

    expect(await updateState(server, bot, { action: 'forget', id: 1 })).toContain('Forgot [1]')
    expect(await updateState(server, bot, { action: 'forget', id: 1 })).toContain('There is no fact [1] in your memory.')
    expect(await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'The owner likes spaces.' })).toContain('Saved as [2]')

    await compact(server, bot)
    const prompt = await nextPrompt(server, bot)
    expect(prompt).toContain('- [2] (learned 2026-10-28) The owner likes spaces.')
    expect(prompt).not.toContain('tabs')
  })
})

describe('the memory block', () => {
  /** The bot saves a fact; returns its id. */
  async function write(server: TestServer, bot: BotInfo, tier: string, text: string, importance?: number) {
    const answer = await updateState(server, bot, { action: 'write', scope: 'bot', tier, text, ...(importance && { importance }) })
    return Number(/Saved as \[(\d+)\]/.exec(answer)![1])
  }

  /** The prompt's memory block after a compaction, one line per fact. */
  async function memoryLines(server: TestServer, bot: BotInfo) {
    await compact(server, bot)
    const prompt = await nextPrompt(server, bot)
    return JSON.parse(`"${/<memory>(.*?)<\/memory>/.exec(prompt)?.[1] ?? ''}"`).split('\n') as string[]
  }

  /** A fact `length` characters long, starting with `name`. */
  const long = (name: string, length = 480) => `${name} ${'x'.repeat(length - name.length - 1)}`

  it('ranks recent facts by importance, fading by half every 30 days', async () => {
    const { server, bot } = await startWithRex()
    await write(server, bot, 'log', 'Shipped v1.', 4)
    await server.clock.advance(30 * day)
    await write(server, bot, 'log', 'Renamed a variable.', 1)
    await write(server, bot, 'log', 'Fixed the flaky test.', 3)

    const lines = await memoryLines(server, bot)

    expect(lines.filter((line) => line.startsWith('- '))).toEqual([
      '- [3] (learned 2026-11-27) Fixed the flaky test.',
      '- [1] (learned 2026-10-28) Shipped v1.',
      '- [2] (learned 2026-11-27) Renamed a variable.',
    ])
    expect(lines).toContain('Recently:')
    expect(lines).not.toContain('Profile:')
  })

  it('lists profile facts first, dropping the least important past 2,000 characters', async () => {
    const { server, bot } = await startWithRex()
    for (const importance of [2, 5, 1, 4, 3]) await write(server, bot, 'profile', long(`Profile ${importance}`), importance)
    await write(server, bot, 'log', 'Shipped v1.')

    const lines = await memoryLines(server, bot)

    const facts = lines.filter((line) => line.startsWith('- '))
    expect(facts.map((line) => /\) (\w+ \d|Shipped)/.exec(line)![1])).toEqual(['Profile 5', 'Profile 4', 'Profile 3', 'Shipped'])
    expect(lines.indexOf('Profile:')).toBeLessThan(lines.indexOf('Recently:'))
    expect(facts.slice(0, 3).join('\n').length).toBeLessThanOrEqual(2000)
  })

  it('cuts recent facts at 4,000 characters; those below the cut stay out', async () => {
    const { server, bot } = await startWithRex()
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      await write(server, bot, 'log', long(`Log ${n}`))
      await server.clock.advance(60_000)
    }

    const facts = (await memoryLines(server, bot)).filter((line) => line.startsWith('- '))

    expect(facts.map((line) => /\) (Log \d)/.exec(line)![1])).toEqual(['Log 9', 'Log 8', 'Log 7', 'Log 6', 'Log 5', 'Log 4', 'Log 3'])
    expect(facts.join('\n').length).toBeLessThanOrEqual(4000)
  })

  it('shows a note for 7 days, then leaves it out while log facts stay', async () => {
    const { server, bot } = await startWithRex()
    await write(server, bot, 'note', 'The owner is away this week.')
    await write(server, bot, 'log', 'The owner went on holiday.')

    await server.clock.advance(7 * day - 60_000)
    expect((await memoryLines(server, bot)).join('\n')).toContain('The owner is away this week.')
    await server.clock.advance(60_000)
    const lines = (await memoryLines(server, bot)).join('\n')
    expect(lines).not.toContain('The owner is away this week.')
    expect(lines).toContain('The owner went on holiday.')
  })

  it('is left out while the bot remembers nothing', async () => {
    const { server, bot } = await startWithRex()
    await compact(server, bot)

    expect(await nextPrompt(server, bot)).not.toContain('<memory>')
  })

  it("dates facts in the owner's time zone", async () => {
    const { server, bot } = await startWithRex({ now: new Date('2026-10-28T23:30:00Z') })
    await server.client.general.updateSettings({ timeZone: 'Asia/Tokyo' })
    await write(server, bot, 'profile', 'The owner lives in Tokyo.')

    expect(await memoryLines(server, bot)).toContain('- [1] (learned 2026-10-29) The owner lives in Tokyo.')
  })
})

describe("another bot's memory", () => {
  it("is out of a bot's reach: unknown, gone and foreign ids answer alike, and the fact stays as it was", async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', instructions: 'Ana reviews code.' })
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Rex keeps the deploy key in the vault.' })
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Short-lived.' })
    await updateState(server, bot, { action: 'forget', id: 2 })

    const answers = []
    for (const action of [{ action: 'edit', text: 'Rex keeps nothing.' }, { action: 'forget' }]) {
      answers.push(
        (await updateState(server, ana, { ...action, id: 1 })).replace('[1]', '[id]'),
        (await updateState(server, ana, { ...action, id: 2 })).replace('[2]', '[id]'),
        (await updateState(server, ana, { ...action, id: 99 })).replace('[99]', '[id]'),
      )
    }

    expect(answers[0]).toContain('There is no fact [id] in your memory.')
    expect(new Set(answers.slice(0, 3)).size).toBe(1)
    expect(new Set(answers.slice(3)).size).toBe(1)
    for (const target of [bot, ana]) await compact(server, target)
    expect(await nextPrompt(server, bot)).toContain('- [1] (learned 2026-10-28) Rex keeps the deploy key in the vault.')
    expect(await nextPrompt(server, ana)).not.toContain('deploy key')
  })
})

describe('the Memory pane', () => {
  it("lists the bot's facts with their tier, importance and date, oldest first, and none of another bot's", async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', instructions: 'Ana reviews code.' })
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'The owner likes tabs.', importance: 5 })
    await server.clock.advance(day)
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'note', text: 'The build is red.' })
    await updateState(server, ana, { action: 'write', scope: 'bot', tier: 'log', text: 'Reviewed the fix.' })

    expect(await server.client.bots.memory({ botId: bot.id })).toEqual([
      {
        id: 1,
        tier: 'profile',
        content: 'The owner likes tabs.',
        importance: 5,
        source: 'bot',
        sourceBotName: 'Rex',
        createdAt: Date.parse('2026-10-28T12:00:00Z'),
        updatedAt: Date.parse('2026-10-28T12:00:00Z'),
      },
      {
        id: 2,
        tier: 'note',
        content: 'The build is red.',
        importance: 3,
        source: 'bot',
        sourceBotName: 'Rex',
        createdAt: Date.parse('2026-10-29T12:00:00Z'),
        updatedAt: Date.parse('2026-10-29T12:00:00Z'),
      },
    ])
    expect((await server.client.bots.memory({ botId: ana.id })).map((fact) => fact.content)).toEqual(['Reviewed the fix.'])
  })

  it('keeps facts below the cut and expired notes, which the prompt leaves out', async () => {
    const { server, bot } = await startWithRex()
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'note', text: 'The owner is away this week.' })
    await server.clock.advance(8 * day)
    await compact(server, bot)

    expect(await nextPrompt(server, bot)).not.toContain('The owner is away this week.')
    expect((await server.client.bots.memory({ botId: bot.id })).map((fact) => fact.content)).toEqual(['The owner is away this week.'])
  })

  it("doesn't list the memory of a bot that doesn't exist", async () => {
    const { server } = await startWithRex()

    await expect(server.client.bots.memory({ botId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('deleting a bot', () => {
  it('deletes its bot memory', async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana', instructions: 'Ana reviews code.' })
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'The owner likes tabs.' })
    await updateState(server, ana, { action: 'write', scope: 'bot', tier: 'profile', text: 'Ana reviews on Mondays.' })

    await server.client.bots.delete({ botId: bot.id })

    await expect(server.client.bots.memory({ botId: bot.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const rows = await server.db.select().from(memories)
    expect(rows.map((row) => row.content)).toEqual(['Ana reviews on Mondays.'])
  })
})

describe('shared memory', () => {
  async function withAna(server: TestServer) {
    return server.client.bots.create({ ...rex, name: 'Ana', instructions: 'Ana reviews code.' })
  }

  it("reaches a second bot's prompt with its next compaction, tagged with its writer, under the precedence line", async () => {
    const { server, bot } = await startWithRex()
    const ana = await withAna(server)
    expect(await nextPrompt(server, ana)).not.toContain('<memory>')

    expect(await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner is called Sam.' })).toContain('Saved as [1]')
    expect(await nextPrompt(server, ana)).not.toContain('The owner is called Sam.')

    await compact(server, ana)
    const prompt = await nextPrompt(server, ana)
    expect(prompt).toContain('- [1] (learned 2026-10-28) [via Rex] The owner is called Sam.')
    expect(prompt).toContain('instructions > bot memory > shared memory')
  })

  it('is reviewed and audited as memory_shared_write for every write, edit and forget; bot memory is not', async () => {
    const { server, bot } = await startWithRex()
    const ana = await withAna(server)
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Rex builds with pnpm.' })
    await updateState(server, bot, { action: 'edit', id: 1, text: 'Rex builds with turbo.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner is called Sam.' })

    expect(await updateState(server, ana, { action: 'edit', id: 2, text: 'The owner is called Samuel.' })).toContain('Updated [2]')
    expect(await updateState(server, ana, { action: 'forget', id: 2 })).toContain('Forgot [2]')
    await updateState(server, bot, { action: 'forget', id: 1 })

    expect(await server.client.bots.audit({ botId: bot.id })).toMatchObject([
      {
        surface: 'memory_shared_write',
        tool: 'update_state',
        input: { target: 'memory', action: 'write', scope: 'shared', text: 'The owner is called Sam.' },
        verdict: { decision: 'allow' },
      },
    ])
    expect(await server.client.bots.audit({ botId: ana.id })).toMatchObject([
      // Pinned to the scope reviewed: the call can only change a shared fact.
      { surface: 'memory_shared_write', input: { action: 'edit', id: 2, scope: 'shared' } },
      { surface: 'memory_shared_write', input: { action: 'forget', id: 2, scope: 'shared' } },
    ])
  })

  it('is not written when the orchestrator blocks the write', async () => {
    const { server, bot } = await startWithRex({ orchestrator: { review: async () => ({ decision: 'deny', reason: 'not about the owner' }) } })
    await server.client.orchestrator.updateModes({ memory_shared_write: 'enforce' })

    expect(await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'Rex is the best bot.' })).toContain('not about the owner')
    expect(await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Rex is the best bot.' })).toContain('Saved as [1]')

    expect(await server.client.sharedMemory.list()).toEqual([])
  })

  it("keeps a deleted bot's shared facts, shown as via Name (deleted) in prompts and in Settings", async () => {
    const { server, bot } = await startWithRex()
    const ana = await withAna(server)
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner is called Sam.', importance: 5 })
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Rex builds with pnpm.' })
    await server.clock.advance(day)
    await updateState(server, ana, { action: 'write', scope: 'shared', tier: 'log', text: 'The owner moved to Lisbon.' })

    await server.client.bots.delete({ botId: bot.id })

    expect(await server.client.sharedMemory.list()).toEqual([
      {
        id: 1,
        tier: 'profile',
        content: 'The owner is called Sam.',
        importance: 5,
        source: 'bot',
        sourceBotName: 'Rex (deleted)',
        createdAt: Date.parse('2026-10-28T12:00:00Z'),
        updatedAt: Date.parse('2026-10-28T12:00:00Z'),
      },
      {
        id: 3,
        tier: 'log',
        content: 'The owner moved to Lisbon.',
        importance: 3,
        source: 'bot',
        sourceBotName: 'Ana',
        createdAt: Date.parse('2026-10-29T12:00:00Z'),
        updatedAt: Date.parse('2026-10-29T12:00:00Z'),
      },
    ])
    await compact(server, ana)
    const prompt = await nextPrompt(server, ana)
    expect(prompt).toContain('- [1] (learned 2026-10-28) [via Rex (deleted)] The owner is called Sam.')
    expect(prompt).toContain('- [3] (learned 2026-10-29) [via Ana] The owner moved to Lisbon.')
    expect(prompt).not.toContain('pnpm')
  })

  it("reaches a bot's own bot memory and shared memory, whoever wrote it, never another bot's bot memory", async () => {
    const { server, bot } = await startWithRex()
    const ana = await withAna(server)
    await updateState(server, bot, { action: 'write', scope: 'bot', tier: 'profile', text: 'Rex keeps the deploy key in the vault.' })
    await updateState(server, bot, { action: 'write', scope: 'shared', tier: 'profile', text: 'The owner is called Sam.' })
    await updateState(server, ana, { action: 'write', scope: 'bot', tier: 'profile', text: 'Ana reviews on Mondays.' })

    expect(await updateState(server, ana, { action: 'edit', id: 1, text: 'Rex keeps nothing.' })).toContain('There is no fact [1] in your memory.')
    expect(await updateState(server, ana, { action: 'edit', id: 2, text: 'The owner is called Samuel.' })).toContain('Updated [2]')
    expect(await updateState(server, ana, { action: 'edit', id: 3, importance: 4 })).toContain('Updated [3]')

    // Only the shared edit was reviewed: reaching for Rex's fact left no trace.
    expect((await server.client.bots.audit({ botId: ana.id })).map((entry) => entry.input)).toMatchObject([{ action: 'edit', id: 2 }])
    expect(await server.client.sharedMemory.list()).toMatchObject([{ id: 2, content: 'The owner is called Samuel.', sourceBotName: 'Rex' }])
    expect((await server.client.bots.memory({ botId: bot.id })).map((fact) => fact.content)).toEqual(['Rex keeps the deploy key in the vault.'])
    expect((await server.client.bots.memory({ botId: ana.id })).map((fact) => fact.content)).toEqual(['Ana reviews on Mondays.'])
    await compact(server, bot)
    const prompt = await nextPrompt(server, bot)
    expect(prompt).toContain('- [1] (learned 2026-10-28) Rex keeps the deploy key in the vault.')
    expect(prompt).toContain('- [2] (learned 2026-10-28) [via Rex] The owner is called Samuel.')
    expect(prompt).not.toContain('Mondays')
  })
})
