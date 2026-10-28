import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callsTools, endsSilently, type FakeMcpServer, recordingTool, startFakeMcpServer } from '@openbot/agent/testing'
import { contract } from '@openbot/api-contract'
import { systemCredentials } from '@openbot/db'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

/** A catalog of one plugin, `notes`, hosted by `fake`. */
async function notesCatalog(fake: FakeMcpServer): Promise<string> {
  const catalog = await mkdtemp(join(tmpdir(), 'openbot-catalog-'))
  cleanups.push(() => rm(catalog, { recursive: true, force: true }))
  const root = join(catalog, 'notes')
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'notes', description: 'Notes', icon: './logo.svg' }))
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { notes: { type: 'http', url: fake.url } } }))
  await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  return catalog
}

/** Every step of connecting a `notes` account from the page at `origin`, signing in on `fake`. */
async function connectSteps(server: TestServer, fake: FakeMcpServer, origin: string) {
  const seen: unknown[] = []
  let signInId = ''
  let endsOn = ''
  for await (const step of await server.client.plugins.connect({ name: 'notes', origin })) {
    seen.push(step)
    if (step.type === 'started') signInId = step.signInId
    if (step.type === 'auth_url') {
      endsOn = await fake.authorize(step.url)
      if (endsOn.startsWith(origin)) seen.push(await server.fetch(endsOn.slice(origin.length), { redirect: 'manual' }).then((response) => [...response.headers]))
    }
    if (step.type === 'prompt') await server.client.plugins.answer({ signInId, promptId: step.promptId, value: endsOn })
    if (step.type === 'failed') throw new Error(step.message)
  }
  return seen
}

const apiKey = 'sk-fake-do-not-leak-0123456789'
const answer = (value: string | (() => string)) => (typeof value === 'function' ? value() : value)

/** Every step of a sign-in, answering prompts with `answers` in order and approving device codes. */
async function signInSteps(server: TestServer, providerId: string, method: 'api_key' | 'oauth', answers: (string | (() => string))[]) {
  const steps = await server.client.providers.connect({ providerId, method })
  const seen: unknown[] = []
  let signInId = ''
  for await (const step of steps) {
    seen.push(step)
    if (step.type === 'started') signInId = step.signInId
    if (step.type === 'prompt') await server.client.providers.answer({ signInId, promptId: step.promptId, value: answer(answers.shift()!) })
    if (step.type === 'device_code') server.providers.device.approve()
    if (step.type === 'failed') throw new Error(step.message)
  }
  return seen
}

/** Leaf procedure paths of the contract, e.g. `providers.list`. */
function procedurePaths(node: object, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    '~orpc' in value ? [`${prefix}${key}`] : procedurePaths(value, `${prefix}${key}.`),
  )
}

describe('system credentials', () => {
  it('are never returned by any procedure', async () => {
    const fake = await startFakeMcpServer()
    cleanups.push(() => fake.close())
    const server = await createTestServer({ tools: [recordingTool('runShell', 'shell').tool], catalog: await notesCatalog(fake) })
    servers.push(server)
    const pluginSteps = [...(await connectSteps(server, fake, 'http://192.168.1.25:3000')), ...(await connectSteps(server, fake, 'http://localhost:3000'))]

    // The subscription sign-in mints `access-1` / `refresh-1`, then the API key replaces it.
    const steps = [
      ...(await signInSteps(server, 'fake-device', 'oauth', ['team'])),
      ...(await signInSteps(server, 'fake', 'oauth', [() => server.providers.signIn.redirectUrl('code')])),
      ...(await signInSteps(server, 'fake', 'api_key', [apiKey])),
    ]

    const settings = await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
    const bot = await server.client.bots.create({
      name: 'Rex',
      title: null,
      instructions: '',
      avatarShape: 'blob',
      avatarColor: 'red',
      model: null,
    })
    server.providers.script(callsTools(['runShell', { command: 'ls' }], ['sendMessage', { text: 'Hi' }]), endsSilently())
    const sent = await server.client.chats.send({ chatId: bot.chatId, text: 'Hello', files: [new File(['notes'], 'notes.txt')] })
    await expect.poll(async () => (await server.client.chats.messages({ chatId: bot.chatId })).length).toBe(2)
    await expect.poll(async () => (await server.client.bots.list())[0]!.working).toBe(false)
    server.providers.script(
      callsTools(['askQuestion', { prompt: 'Which one?', options: [{ label: 'This' }] }], ['askQuestion', { prompt: 'Why?', options: [{ label: 'Because' }] }]),
    )
    await server.client.chats.send({ chatId: bot.chatId, text: 'Pick for me' })
    await expect.poll(async () => (await server.client.chats.messages({ chatId: bot.chatId })).length).toBe(5)
    const questions = (await server.client.chats.messages({ chatId: bot.chatId })).filter((message) => message.card?.type === 'question')
    const question = questions.find((message) => message.text === 'Which one?')!
    const dismissed = questions.find((message) => message.text === 'Why?')!
    server.providers.script(callsTools(['use_computer', { goal: 'Look at the shop', reason: 'Testing' }]), callsTools(['needs_help', { instruction: 'Sign in' }]))
    await server.client.chats.send({ chatId: bot.chatId, text: 'Look at the shop' })
    await expect.poll(async () => (await server.client.chats.messages({ chatId: bot.chatId })).length).toBe(7)
    await expect.poll(async () => (await server.client.bots.list())[0]!.working).toBe(false)
    const takeOver = (await server.client.chats.messages({ chatId: bot.chatId })).at(-1)!
    const ana = await server.client.bots.create({ name: 'Ana', title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })
    // Both members pass.
    server.providers.script(endsSilently(), endsSilently())
    const group = await server.client.groups.create({ memberIds: [bot.id, ana.id], text: 'Hello, team' })
    await server.rounds.idle(group.chat.id)
    const routine = await server.client.routines.create({ botId: bot.id, name: 'Digest', prompt: 'Send me a digest.', schedule: '@daily' })
    const routineUpdated = await server.client.routines.update({ botId: bot.id, routineId: routine.id, schedule: '@weekly' })
    const routinePaused = await server.client.routines.pause({ botId: bot.id, routineId: routine.id })
    const routineResumed = await server.client.routines.resume({ botId: bot.id, routineId: routine.id })
    server.providers.script(callsTools(['sendMessage', { text: 'Digest.' }]), endsSilently())
    const routineRun = await server.client.routines.testRun({ botId: bot.id, routineId: routine.id })
    await expect.poll(async () => (await server.client.routines.runs({ botId: bot.id, routineId: routine.id }))[0]?.status).toBe('ran')
    const routineRuns = await server.client.routines.runs({ botId: bot.id, routineId: routine.id })
    const routineList = await server.client.routines.list({ botId: bot.id })
    await server.client.routines.delete({ botId: bot.id, routineId: routine.id })
    server.providers.script(callsTools(['sendMessage', { text: 'OK' }]), endsSilently(), callsTools(['sendMessage', { text: 'OK' }]), endsSilently())

    // Each procedure that returns data, called once it has something to return. A new procedure fails the check
    // below until it is added here.
    const responses: Record<string, unknown> = {
      health: await server.client.health(),
      'providers.list': await server.client.providers.list(),
      'providers.connect': steps,
      'providers.answer': null,
      'providers.disconnect': null,
      'plugins.list': await server.client.plugins.list(),
      'plugins.get': await server.client.plugins.get({ name: 'notes' }),
      'plugins.icon': await (await server.client.plugins.icon({ name: 'notes' })).body.text(),
      'plugins.connect': pluginSteps,
      'plugins.answer': null,
      'plugins.oauthCallback': null,
      'plugins.renameAccount': await server.client.plugins.renameAccount({ name: 'notes', account: 'account1', displayName: 'Work' }),
      'plugins.disconnectAccount': null,
      'models.list': await server.client.models.list(),
      'models.getSettings': await server.client.models.getSettings(),
      'models.updateSettings': settings,
      'onboarding.status': await server.client.onboarding.status(),
      'bots.list': await server.client.bots.list(),
      'bots.create': bot,
      'bots.update': await server.client.bots.update({ botId: bot.id, title: 'Builder' }),
      'bots.getOrchestratorModes': await server.client.bots.getOrchestratorModes({ botId: bot.id }),
      'bots.updateOrchestratorModes': await server.client.bots.updateOrchestratorModes({ botId: bot.id, overrides: { shell: 'enforce' } }),
      'bots.audit': await server.client.bots.audit({ botId: bot.id }),
      'bots.addFact': await server.client.bots.addFact({ botId: bot.id, tier: 'profile', text: 'The owner likes tabs.' }),
      'bots.editFact': await server.client.bots.editFact({ botId: bot.id, factId: 1, importance: 4 }),
      'bots.memory': await server.client.bots.memory({ botId: bot.id }),
      'bots.deleteFact': null,
      'screens.status': await server.client.screens.status({ botId: bot.id }),
      'screens.ticket': await server.client.screens.ticket({ botId: bot.id }),
      'orchestrator.getModes': await server.client.orchestrator.getModes(),
      'orchestrator.updateModes': await server.client.orchestrator.updateModes({ vault: 'enforce' }),
      'general.detectTimeZone': await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' }),
      'general.updateSettings': await server.client.general.updateSettings({ timeZone: 'Asia/Tokyo' }),
      'general.getSettings': await server.client.general.getSettings(),
      'sharedMemory.add': await server.client.sharedMemory.add({ tier: 'profile', text: 'The owner is called Sam.' }),
      'sharedMemory.edit': await server.client.sharedMemory.edit({ factId: 2, importance: 4 }),
      'sharedMemory.list': await server.client.sharedMemory.list(),
      'sharedMemory.delete': null,
      'routines.list': routineList,
      'routines.create': routine,
      'routines.update': routineUpdated,
      'routines.pause': routinePaused,
      'routines.resume': routineResumed,
      'routines.testRun': routineRun,
      'routines.runs': routineRuns,
      'routines.delete': null,
      'bots.delete': null,
      'chats.list': await server.client.chats.list(),
      'chats.read': await server.client.chats.read({ chatId: bot.chatId }),
      'chats.setPinned': await server.client.chats.setPinned({ chatIds: [bot.chatId] }),
      'chats.messages': await server.client.chats.messages({ chatId: bot.chatId }),
      'chats.send': sent,
      'chats.attachment': await (await server.client.chats.attachment({ messageId: sent.id, attachmentId: sent.attachments[0]!.id })).body.text(),
      'chats.answer': await server.client.chats.answer({ messageId: question.id, answer: { option: 0 } }),
      'chats.dismiss': await server.client.chats.dismiss({ messageId: dismissed.id }),
      'chats.handBack': await server.client.chats.handBack({ messageId: takeOver.id, outcome: 'done' }),
      'groups.create': group,
      'groups.update': await server.client.groups.update({ chatId: group.chat.id, title: 'Team' }),
      'groups.delete': null,
      events: null,
      openapi: await (await server.fetch('/api/openapi.json')).json(),
    }
    expect(Object.keys(responses).filter((path) => path !== 'openapi').sort()).toEqual(procedurePaths(contract).sort())

    const everything = JSON.stringify(responses)
    expect(fake.issuedTokens).toHaveLength(4)
    for (const secret of [apiKey, 'access-1', 'refresh-1', 'device-access', 'device-refresh', ...fake.issuedTokens]) {
      expect(everything).not.toContain(secret)
    }
  })

  it('are encrypted at rest', async () => {
    const server = await createTestServer()
    servers.push(server)
    await signInSteps(server, 'fake', 'api_key', [apiKey])

    const rows = await server.db.select().from(systemCredentials)

    expect(rows.map((row) => row.key)).toEqual(['provider:fake'])
    expect(JSON.stringify(rows)).not.toContain(apiKey)
  })
})
