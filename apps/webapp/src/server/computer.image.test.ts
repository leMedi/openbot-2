import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { botUser, userExists } from '@openbot/agent'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

// The real computer, as in the runtime image: run with `pnpm dev:sh`, then
// `pnpm --filter @openbot/webapp exec vitest run src/server/computer.image.test.ts`. Skipped elsewhere.
const inRuntimeImage = !!process.env.OPENBOT_HOME && userExists(botUser)

const servers: TestServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    // Deleting the bots deletes their folders from the real home.
    for (const bot of await server.client.bots.list()) await server.client.bots.delete({ botId: bot.id })
    await server.close()
  }
})

const newBot = (name: string): NewBot => ({ name, title: null, instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null })

async function start() {
  const server = await createTestServer({ realComputer: true })
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  return server
}

/** Has the bot make `calls`, one round each; returns what each call gave back to the model. */
async function work(server: TestServer, bot: BotInfo, ...calls: [name: string, args: Record<string, unknown>][]) {
  const before = server.providers.requests.length
  // It answers the owner last, so the reply guarantee has nothing to remind it of.
  server.providers.script(...calls.map((call) => callsTools(call as [string, never])), callsTools(['sendMessage', { text: 'Done' }]), endsSilently())
  await server.client.chats.send({ chatId: bot.chatId, text: 'Get to work' })
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working, { timeout: 30_000 }).toBe(false)
  return server.providers.requests.slice(before + 1).map((request) => JSON.stringify(request.messages.at(-1)))
}

describe.skipIf(!inRuntimeImage)('bots on the real computer', () => {
  it('run commands as openbot, with sudo, starting in their own folder', async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))

    const [result] = await work(server, rex, ['bash', { command: 'whoami; sudo --non-interactive whoami; pwd; echo "home=$HOME"' }])

    expect(result).toContain(`openbot\\nroot\\n${join(server.home, 'bots', rex.id)}\\nhome=${server.home}`)
    expect(await server.client.bots.audit({ botId: rex.id })).toMatchObject([
      { surface: 'shell', tool: 'bash', input: { command: 'whoami; sudo --non-interactive whoami; pwd; echo "home=$HOME"' } },
    ])
  })

  it("write, edit and read files as openbot, and reach the shared folder and other bots' folders", async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))
    await work(server, ada, ['write', { path: 'draft.md', content: 'Ada was here\n' }])
    const shared = join(server.home, 'shared', `plan-${rex.id}.md`)

    const [, , read, owner, other] = await work(
      server,
      rex,
      ['write', { path: 'notes.md', content: 'Ship on Friday\n' }],
      ['edit', { path: 'notes.md', edits: [{ oldText: 'Friday', newText: 'Monday' }] }],
      ['read', { path: 'notes.md' }],
      ['bash', { command: `stat -c %U notes.md && echo "The plan" > ${shared} && stat -c %U ${shared} && rm ${shared}` }],
      ['read', { path: `../${ada.id}/draft.md` }],
    )

    expect(read).toContain('Ship on Monday')
    expect(owner).toContain('openbot\\nopenbot')
    expect(other).toContain('Ada was here')
    expect(readFileSync(join(server.home, 'bots', rex.id, 'notes.md'), 'utf8')).toBe('Ship on Monday\n')
  })

  it('lose their folder when deleted', async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    await work(server, rex, ['write', { path: 'notes.md', content: 'hi' }])
    expect(existsSync(join(server.home, 'bots', rex.id, 'notes.md'))).toBe(true)

    await server.client.bots.delete({ botId: rex.id })

    expect(existsSync(join(server.home, 'bots', rex.id))).toBe(false)
  })
})
