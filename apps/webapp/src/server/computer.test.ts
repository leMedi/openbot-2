import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer, type TestServerOptions } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = {
  name: 'Rex',
  title: null,
  instructions: '',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
}

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

/** Has the bot make `calls`, one round each, then answer; returns what each call gave back to the model, in order. */
async function work(server: TestServer, bot: BotInfo, ...calls: [name: string, args: Record<string, unknown>][]) {
  const before = server.providers.requests.length
  // It answers the owner last, so the reply guarantee has nothing to remind it of.
  server.providers.script(...calls.map((call) => callsTools(call as [string, never])), callsTools(['sendMessage', { text: 'Done' }]), endsSilently())
  await server.client.chats.send({ chatId: bot.chatId, text: 'Get to work' })
  await untilIdle(server, bot)
  return server.providers.requests.slice(before + 1).map((request) => JSON.stringify(request.messages.at(-1)))
}

describe('bots on the computer', () => {
  it('run shell commands on the computer and see their output', async () => {
    const { server, bot } = await startWithRex({
      shell: (command) => (command === 'whoami' ? { stdout: 'openbot\n', stderr: '', exitCode: 0 } : undefined),
    })

    const [result] = await work(server, bot, ['bash', { command: 'whoami' }])

    expect(server.computer.calls.filter((call) => call.kind === 'shell.exec')).toEqual([{ bot: 'Rex', kind: 'shell.exec', command: 'whoami' }])
    expect(result).toContain('openbot')
  })

  it('see a failed command fail, with its output', async () => {
    const { server, bot } = await startWithRex({
      shell: () => ({ stdout: '', stderr: 'cat: missing.txt: No such file or directory\n', exitCode: 1 }),
    })

    const [result] = await work(server, bot, ['bash', { command: 'cat missing.txt' }])

    expect(result).toContain('No such file or directory')
    expect(result).toContain('"isError":true')
  })

  it('write, edit and read files, starting in their own folder', async () => {
    const { server, bot } = await startWithRex()

    const [, , read] = await work(
      server,
      bot,
      ['write', { path: 'notes.md', content: 'Ship on Friday\n' }],
      ['edit', { path: 'notes.md', edits: [{ oldText: 'Friday', newText: 'Monday' }] }],
      ['read', { path: 'notes.md' }],
    )

    expect(await readFile(join(server.home, 'bots', bot.id, 'notes.md'), 'utf8')).toBe('Ship on Monday\n')
    expect(read).toContain('Ship on Monday')
  })

  it("reach the shared folder and other bots' folders", async () => {
    const { server, bot } = await startWithRex()
    const ada = await server.client.bots.create({ ...rex, name: 'Ada' })
    await mkdir(join(server.home, 'bots', ada.id), { recursive: true })
    await writeFile(join(server.home, 'bots', ada.id, 'draft.md'), 'Ada was here\n')

    const [, read] = await work(
      server,
      bot,
      ['write', { path: join(server.home, 'shared', 'plan.md'), content: 'The plan\n' }],
      ['read', { path: `../${ada.id}/draft.md` }],
    )

    expect(await readFile(join(server.home, 'shared', 'plan.md'), 'utf8')).toBe('The plan\n')
    expect(read).toContain('Ada was here')
  })

  it('are told where their folder, the shared folder and the other bots are', async () => {
    const { server, bot } = await startWithRex()
    const ada = await server.client.bots.create({ ...rex, name: 'Ada' })

    await work(server, bot)

    const system = JSON.stringify(server.providers.requests.at(-1)!.messages)
    expect(system).toContain(join(server.home, 'bots', bot.id))
    expect(system).toContain(join(server.home, 'shared'))
    expect(system).toContain(join(server.home, 'bots', bot.id, 'uploads'))
    expect(system).toContain(`Ada: ${join(server.home, 'bots', ada.id)}`)
    expect(system).toContain('sudo')
  })

  it('have every shell command and file change reviewed and written to the audit log', async () => {
    const { server, bot } = await startWithRex()

    await work(
      server,
      bot,
      ['bash', { command: 'sudo apt-get install -y jq' }],
      ['write', { path: 'a.txt', content: 'a' }],
      ['edit', { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] }],
      ['read', { path: 'a.txt' }],
    )

    expect((await server.client.bots.audit({ botId: bot.id })).map(({ surface, tool, input }) => ({ surface, tool, input }))).toEqual([
      { surface: 'shell', tool: 'bash', input: { command: 'sudo apt-get install -y jq' } },
      { surface: 'shell', tool: 'write', input: { path: 'a.txt', content: 'a' } },
      { surface: 'shell', tool: 'edit', input: { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] } },
    ])
  })

  it('lose their folder when deleted', async () => {
    const { server, bot } = await startWithRex()
    await work(server, bot, ['write', { path: 'notes.md', content: 'hi' }])
    expect(existsSync(join(server.home, 'bots', bot.id))).toBe(true)

    await server.client.bots.delete({ botId: bot.id })

    expect(existsSync(join(server.home, 'bots', bot.id))).toBe(false)
  })
})
