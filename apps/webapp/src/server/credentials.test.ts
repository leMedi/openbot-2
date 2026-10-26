import { callsTools, endsSilently } from '@openbot/agent/testing'
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
    const server = await createTestServer()
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
    server.providers.script(callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())
    const sent = await server.client.chats.send({ chatId: bot.chatId, text: 'Hello' })
    await expect.poll(async () => (await server.client.chats.messages({ chatId: bot.chatId })).length).toBe(2)

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
      'bots.stop': null,
      'chats.messages': await server.client.chats.messages({ chatId: bot.chatId }),
      'chats.send': sent,
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
