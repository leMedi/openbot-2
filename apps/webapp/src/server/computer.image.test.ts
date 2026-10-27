import { existsSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { botUser, openBotComputer, userExists } from '@openbot/agent'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { connectScreens, defaultDaemonSocket } from '@openbot/computer'
import { describeComputerContract } from '@openbot/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

// The real computer, as in the runtime image: run with `pnpm dev:sh`, then
// `pnpm --filter @openbot/webapp exec vitest run src/server/computer.image.test.ts`. Skipped elsewhere.
const inRuntimeImage = !!process.env.OPENBOT_HOME && userExists(botUser)

const socketPath = process.env.OPENBOT_DESKTOPD_SOCKET || defaultDaemonSocket

/** The processes of a bot's screen, from the screen daemon's diagnostics. */
function screenPids(botId: string): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    request({ socketPath, path: `/screens/${botId}/pids` }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve(JSON.parse(body)))
    })
      .on('error', reject)
      .end()
  })
}

// Seam 2 on the real computer: the screen daemon running as openbot under supervisord, and the bots' shell.
describe.skipIf(!inRuntimeImage)('the real computer', () => {
  describeComputerContract(
    'the real computer',
    async () => {
      const home = process.env.OPENBOT_HOME!
      const computer = openBotComputer({ home })
      const client = () => ({ screens: connectScreens({ socketPath }), shell: { exec: computer.exec.bind(computer) } })
      return {
        computer: client(),
        reconnect: async () => client(),
        // Every process of the screen, killed as openbot (who owns them), each with its process group.
        crash: async (bot) => {
          const pids = Object.values(await screenPids(bot.id))
          await computer.exec(bot, `kill -KILL ${pids.map((pid) => `-${pid}`).join(' ')}`)
        },
        user: botUser,
        folder: (bot) => computer.folder(bot.id),
        close: async () => {
          await computer.exec({ id: 'contract', name: 'Contract' }, `rm -rf ${join(home, 'bots')}/contract-*`)
          await computer.close()
        },
      }
    },
    { firstDisplay: 900, timeout: 60_000 },
  )
})

/** Calls the DevTools protocol of the browser listening on `port`, once. */
async function devtools(port: number, method: string, params: object = {}): Promise<Record<string, unknown>> {
  const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  try {
    return await new Promise((resolve, reject) => {
      ws.onmessage = (event) => {
        const reply = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } }
        if (reply.id !== 1) return
        if (reply.error) reject(new Error(reply.error.message))
        else resolve(reply.result!)
      }
      ws.send(JSON.stringify({ id: 1, method, params }))
    })
  } finally {
    ws.close()
  }
}

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

  it("get the owner's files in their uploads folder as openbot, and send files back", async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
    server.providers.script(
      callsTools(['bash', { command: 'stat -c %U uploads/notes.txt uploads/screen.png && head -c 5000000 /dev/zero > big.bin' }]),
      callsTools(['sendMessage', { text: 'Here', attachments: ['big.bin'] }]),
      endsSilently(),
    )

    const sent = await server.client.chats.send({
      chatId: rex.chatId,
      text: 'Look',
      files: [new File(['Ship on Friday\n'], 'notes.txt', { type: 'text/plain' }), new File([pixel], 'screen.png', { type: 'image/png' })],
    })
    await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === rex.id)?.working, { timeout: 30_000 }).toBe(false)

    const uploads = join(server.home, 'bots', rex.id, 'uploads')
    expect(sent.attachments.map((file) => file.path)).toEqual([join(uploads, 'notes.txt'), join(uploads, 'screen.png')])
    expect(JSON.stringify(server.providers.requests[0]!.messages.at(-1))).toContain(pixel.toString('base64'))
    expect(JSON.stringify(server.providers.requests[1]!.messages.at(-1))).toContain('openbot\\nopenbot')
    const reply = (await server.client.chats.messages({ chatId: rex.chatId })).at(-1)!
    expect(reply.attachments).toMatchObject([{ name: 'big.bin', size: 5_000_000 }])
    const download = await server.client.chats.attachment({ messageId: reply.id, attachmentId: reply.attachments[0]!.id })
    expect(download.body.size).toBe(5_000_000)
  })

  it('get a screen with their own browser profile; a login in one is not seen in another', { timeout: 120_000 }, async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    const ada = await server.client.bots.create(newBot('Ada'))
    for (const bot of [rex, ada]) {
      await expect.poll(async () => (await server.client.screens.status({ botId: bot.id })).state, { timeout: 60_000 }).toBe('running')
    }
    // Displays from the test harness's offset, 500 up: the browser's DevTools port is 9222 + display.
    const [rexDisplay, adaDisplay] = await Promise.all([rex, ada].map(async (bot) => (await connectScreens({ socketPath }).status(bot)).display!))

    await devtools(9222 + rexDisplay!, 'Storage.setCookies', {
      cookies: [{ name: 'session', value: 'rex-is-signed-in', domain: 'example.com', path: '/', expires: Date.now() / 1000 + 3600 }],
    })

    const cookies = async (display: number) => JSON.stringify(await devtools(9222 + display, 'Storage.getCookies'))
    expect(await cookies(rexDisplay!)).toContain('rex-is-signed-in')
    expect(await cookies(adaDisplay!)).not.toContain('rex-is-signed-in')
    const profile = join(server.home, 'bots', rex.id, 'chromium')
    expect(statSync(profile).isDirectory()).toBe(true)
    expect(existsSync(join(server.home, 'bots', ada.id, 'chromium'))).toBe(true)
  })

  it('stream their screen on a ticket', { timeout: 120_000 }, async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    await expect.poll(async () => (await server.client.screens.status({ botId: rex.id })).state, { timeout: 60_000 }).toBe('running')

    const ws = await server.openStream((await server.client.screens.ticket({ botId: rex.id })).url)
    const greeting = await new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(Buffer.from(event.data as ArrayBuffer).toString('latin1'))
    })

    expect(greeting).toMatch(/^RFB 003\.00\d\n/)
    ws.close()
  })

  it('lose their screen and browser profile when deleted', { timeout: 120_000 }, async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    await expect.poll(async () => (await server.client.screens.status({ botId: rex.id })).state, { timeout: 60_000 }).toBe('running')

    await server.client.bots.delete({ botId: rex.id })

    expect((await connectScreens({ socketPath }).status(rex)).state).toBe('stopped')
    expect(existsSync(join(server.home, 'bots', rex.id, 'chromium'))).toBe(false)
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
