import { callsTools, endsSilently, recordingTool } from '@openbot/agent/testing'
import { contract } from '@openbot/api-contract'
import { systemCredentials } from '@openbot/db'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

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
    const server = await createTestServer({ tools: [recordingTool('runShell', 'shell').tool] })
    servers.push(server)

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
    server.providers.script(callsTools(['askQuestion', { prompt: 'Which one?', options: [{ label: 'This' }] }]))
    await server.client.chats.send({ chatId: bot.chatId, text: 'Pick for me' })
    await expect.poll(async () => (await server.client.chats.messages({ chatId: bot.chatId })).length).toBe(4)
    const question = (await server.client.chats.messages({ chatId: bot.chatId })).at(-1)!
    server.providers.script(callsTools(['use_computer', { goal: 'Look at the shop', reason: 'Testing' }]), callsTools(['needs_help', { instruction: 'Sign in' }]))
    await server.client.chats.send({ chatId: bot.chatId, text: 'Look at the shop' })
    await expect.poll(async () => (await server.client.chats.messages({ chatId: bot.chatId })).length).toBe(6)
    await expect.poll(async () => (await server.client.bots.list())[0]!.working).toBe(false)
    const takeOver = (await server.client.chats.messages({ chatId: bot.chatId })).at(-1)!
    const ana = await server.client.bots.create({ name: 'Ana', title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })
    // Both members pass.
    server.providers.script(endsSilently(), endsSilently())
    const group = await server.client.groups.create({ memberIds: [bot.id, ana.id], text: 'Hello, team' })
    await server.rounds.idle(group.chat.id)
    server.providers.script(callsTools(['sendMessage', { text: 'OK' }]), endsSilently(), callsTools(['sendMessage', { text: 'OK' }]), endsSilently())

    // Each procedure that returns data, called once it has something to return. A new procedure fails the check
    // below until it is added here.
    const responses: Record<string, unknown> = {
      health: await server.client.health(),
      'providers.list': await server.client.providers.list(),
      'providers.connect': steps,
      'providers.answer': null,
      'providers.disconnect': null,
      'models.list': await server.client.models.list(),
      'models.getSettings': await server.client.models.getSettings(),
      'models.updateSettings': settings,
      'onboarding.status': await server.client.onboarding.status(),
      'bots.list': await server.client.bots.list(),
      'bots.create': bot,
      'bots.update': await server.client.bots.update({ botId: bot.id, title: 'Builder' }),
      'bots.stop': null,
      'bots.getOrchestratorModes': await server.client.bots.getOrchestratorModes({ botId: bot.id }),
      'bots.updateOrchestratorModes': await server.client.bots.updateOrchestratorModes({ botId: bot.id, overrides: { shell: 'enforce' } }),
      'bots.audit': await server.client.bots.audit({ botId: bot.id }),
      'screens.status': await server.client.screens.status({ botId: bot.id }),
      'screens.ticket': await server.client.screens.ticket({ botId: bot.id }),
      'orchestrator.getModes': await server.client.orchestrator.getModes(),
      'orchestrator.updateModes': await server.client.orchestrator.updateModes({ vault: 'enforce' }),
      'bots.delete': null,
      'chats.list': await server.client.chats.list(),
      'chats.read': await server.client.chats.read({ chatId: bot.chatId }),
      'chats.setPinned': await server.client.chats.setPinned({ chatIds: [bot.chatId] }),
      'chats.messages': await server.client.chats.messages({ chatId: bot.chatId }),
      'chats.send': sent,
      'chats.attachment': await (await server.client.chats.attachment({ messageId: sent.id, attachmentId: sent.attachments[0]!.id })).body.text(),
      'chats.answer': await server.client.chats.answer({ messageId: question.id, answer: { option: 0 } }),
      'chats.handBack': await server.client.chats.handBack({ messageId: takeOver.id, outcome: 'done' }),
      'groups.create': group,
      'groups.update': await server.client.groups.update({ chatId: group.chat.id, title: 'Team' }),
      'groups.delete': null,
      events: null,
      openapi: await (await server.fetch('/api/openapi.json')).json(),
    }
    expect(Object.keys(responses).filter((path) => path !== 'openapi').sort()).toEqual(procedurePaths(contract).sort())

    const everything = JSON.stringify(responses)
    for (const secret of [apiKey, 'access-1', 'refresh-1', 'device-access', 'device-refresh']) {
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
