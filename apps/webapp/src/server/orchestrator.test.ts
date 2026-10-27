import { callsTools, endsSilently, recordingTool } from '@openbot/agent/testing'
import type { Orchestrator } from '@openbot/core'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServerOptions, type TestServer } from './testing/harness.ts'

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

/** Denies every action, as a reviewer that finds it unsafe would. */
const denyAll: Orchestrator = { review: async () => ({ decision: 'deny', reason: 'rm -rf is too dangerous' }) }

/** Has the bot call the `runShell` test tool with `input`, then end its run. */
async function callShell(server: TestServer, bot: BotInfo, input: Record<string, string>) {
  server.providers.script(callsTools(['runShell', input]), endsSilently())
  await server.client.chats.send({ chatId: bot.chatId, text: 'Run it' })
  await untilIdle(server, bot)
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

describe('the orchestrator', () => {
  it('reviews a side-effecting tool call and writes it to the audit log', async () => {
    const shell = recordingTool('runShell', 'shell')
    const { server, bot } = await startWithRex({ tools: [shell.tool] })
    server.providers.script(callsTools(['runShell', { command: 'ls' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'List the files' })
    await untilIdle(server, bot)

    expect(shell.calls).toEqual([{ command: 'ls' }])
    expect(await server.client.bots.audit({ botId: bot.id })).toMatchObject([
      { botId: bot.id, surface: 'shell', tool: 'runShell', input: { command: 'ls' }, verdict: { decision: 'allow' }, mode: 'shadow' },
    ])
  })

  it('blocks a denied action in enforce mode and tells the bot why', async () => {
    const shell = recordingTool('runShell', 'shell')
    const { server, bot } = await startWithRex({ tools: [shell.tool], orchestrator: denyAll })
    await server.client.orchestrator.updateModes({ shell: 'enforce' })

    await callShell(server, bot, { command: 'rm -rf /' })

    expect(shell.calls).toEqual([])
    expect(JSON.stringify(server.providers.requests[1]!.messages)).toContain('rm -rf is too dangerous')
    expect(await server.client.bots.audit({ botId: bot.id })).toMatchObject([
      { surface: 'shell', verdict: { decision: 'deny', reason: 'rm -rf is too dangerous' }, mode: 'enforce' },
    ])
  })

  it('logs a denied action in shadow mode without blocking it', async () => {
    const shell = recordingTool('runShell', 'shell')
    const { server, bot } = await startWithRex({ tools: [shell.tool], orchestrator: denyAll })

    await callShell(server, bot, { command: 'rm -rf /tmp/cache' })

    expect(shell.calls).toEqual([{ command: 'rm -rf /tmp/cache' }])
    expect(await server.client.bots.audit({ botId: bot.id })).toMatchObject([{ verdict: { decision: 'deny' }, mode: 'shadow' }])
  })

  it('skips review of a surface that is off', async () => {
    const shell = recordingTool('runShell', 'shell')
    const { server, bot } = await startWithRex({ tools: [shell.tool], orchestrator: denyAll })
    await server.client.orchestrator.updateModes({ shell: 'off' })

    await callShell(server, bot, { command: 'ls' })

    expect(shell.calls).toEqual([{ command: 'ls' }])
    expect(await server.client.bots.audit({ botId: bot.id })).toEqual([])
  })

  it('never reviews read-only tools or messages', async () => {
    const read = recordingTool('readFile', null)
    const { server, bot } = await startWithRex({ tools: [read.tool], orchestrator: denyAll })
    await server.client.orchestrator.updateModes({ shell: 'enforce', vault: 'enforce' })
    server.providers.script(callsTools(['readFile', { path: 'notes.md' }], ['sendMessage', { text: 'Read it' }]), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Read my notes' })
    await untilIdle(server, bot)

    expect(read.calls).toEqual([{ path: 'notes.md' }])
    expect((await server.client.chats.messages({ chatId: bot.chatId })).map((message) => message.text)).toContain('Read it')
    expect(await server.client.bots.audit({ botId: bot.id })).toEqual([])
  })

  it('redacts secrets from what it reviews and logs', async () => {
    const shell = recordingTool('runShell', 'shell')
    const reviewed: unknown[] = []
    const { server, bot } = await startWithRex({
      tools: [shell.tool],
      orchestrator: { review: async (action) => (reviewed.push(action.input), { decision: 'allow' }) },
    })

    await callShell(server, bot, {
      command: 'curl -H "Authorization: Bearer abc.def-123" https://api.example.com && export API_KEY=sk-live-0123456789abcdef',
      password: 'hunter2',
    })

    const [entry] = await server.client.bots.audit({ botId: bot.id })
    const logged = JSON.stringify([reviewed, entry!.input])
    expect(logged).not.toMatch(/abc\.def-123|sk-live-0123456789abcdef|hunter2/)
    expect(entry!.input).toEqual({
      command: 'curl -H "Authorization: Bearer [redacted]" https://api.example.com && export API_KEY=[redacted]',
      password: '[redacted]',
    })
    // The tool itself still runs with the real input.
    expect(shell.calls[0]!.password).toBe('hunter2')
  })
})

describe('orchestrator modes', () => {
  it('are shadow everywhere until the owner sets them', async () => {
    const { server, bot } = await startWithRex()

    expect(await server.client.orchestrator.getModes()).toEqual({
      shell: 'shadow',
      computer_session: 'shadow',
      mcp: 'shadow',
      vault: 'shadow',
      plugin_request: 'shadow',
      routine_change: 'shadow',
      memory_global_write: 'shadow',
    })
    expect(await server.client.bots.getOrchestratorModes({ botId: bot.id })).toMatchObject({ overrides: {}, modes: { shell: 'shadow' } })
  })

  it('can be set globally and overridden per bot', async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })

    await server.client.orchestrator.updateModes({ shell: 'enforce', vault: 'off' })
    expect(await server.client.bots.updateOrchestratorModes({ botId: bot.id, overrides: { shell: 'shadow' } })).toMatchObject({
      overrides: { shell: 'shadow' },
      modes: { shell: 'shadow', vault: 'off', mcp: 'shadow' },
    })
    expect((await server.client.bots.getOrchestratorModes({ botId: ana.id })).modes).toMatchObject({ shell: 'enforce', vault: 'off' })

    const cleared = await server.client.bots.updateOrchestratorModes({ botId: bot.id, overrides: { shell: null } })
    expect(cleared).toMatchObject({ overrides: {}, modes: { shell: 'enforce' } })
  })

  it("a bot's override decides whether its actions are blocked", async () => {
    const shell = recordingTool('runShell', 'shell')
    const { server, bot } = await startWithRex({ tools: [shell.tool], orchestrator: denyAll })
    await server.client.bots.updateOrchestratorModes({ botId: bot.id, overrides: { shell: 'enforce' } })

    await callShell(server, bot, { command: 'rm -rf /' })

    expect(shell.calls).toEqual([])
  })

  it('reject an unknown bot', async () => {
    const { server } = await startWithRex()
    await expect(server.client.bots.getOrchestratorModes({ botId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.bots.audit({ botId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
