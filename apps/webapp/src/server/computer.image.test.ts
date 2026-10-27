import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { botUser, userExists } from '@openbot/agent'
import { callsTools, endsSilently, held, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { connectBrowser, connectDesktop, connectScreens, defaultDaemonSocket } from '@openbot/computer'
import { describeComputerContract, servePages } from '@openbot/core/testing'
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

// Seam 2 on the real computer: the screen daemon running as openbot under supervisord, each screen's Chrome over
// CDP, loading pages this test serves on localhost, and each screen's cua-driver driving Mousepad.
describe.skipIf(!inRuntimeImage)('the real computer', () => {
  describeComputerContract(
    'the real computer',
    async () => {
      const home = process.env.OPENBOT_HOME!
      const pages = await servePages()
      const desktops: { close(): Promise<void> }[] = []
      const client = () => {
        const screens = connectScreens({ socketPath })
        const desktop = connectDesktop({ screens, runAs: botUser })
        desktops.push(desktop)
        return { screens, browser: connectBrowser({ screens }), desktop }
      }
      return {
        computer: client(),
        reconnect: async () => client(),
        // Every process of the screen, killed as openbot (who owns them), each with its process group.
        crash: async (bot) => {
          const pids = Object.values(await screenPids(bot.id))
          execFileSync('sudo', ['--non-interactive', `--user=${botUser}`, 'kill', '-KILL', '--', ...pids.map((pid) => `-${pid}`)])
        },
        page: pages.page,
        editor: 'mousepad',
        close: async () => {
          await Promise.all(desktops.map((desktop) => desktop.close()))
          await pages.close()
          execFileSync('sudo', ['--non-interactive', `--user=${botUser}`, 'sh', '-c', `rm -rf ${join(home, 'bots')}/contract-*`])
        },
      }
    },
    { firstDisplay: 900, timeout: 60_000 },
  )
})

/** Calls the DevTools protocol of the browser listening on `port`, once. */
async function devtools(port: number, method: string, params: object = {}): Promise<Record<string, unknown>> {
  const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
  return cdp(webSocketDebuggerUrl, method, params)
}

/** The text of `url` opened in a new tab of the browser listening on `port`, once it contains `until`. */
async function pageText(port: number, url: string, until: string): Promise<string> {
  const tab = (await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })).json()) as { id: string; webSocketDebuggerUrl: string }
  try {
    let text = ''
    await expect
      .poll(async () => {
        const { result } = (await cdp(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.body.innerText' })) as { result: { value?: string } }
        return (text = result.value ?? '')
      }, { timeout: 15_000 })
      .toContain(until)
    return text
  } finally {
    await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`)
  }
}

/** Calls the DevTools protocol at `endpoint` (a browser's or a tab's), once. */
async function cdp(endpoint: string, method: string, params: object = {}): Promise<Record<string, unknown>> {
  const ws = new WebSocket(endpoint)
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

  it("run their browser in Chrome's sandbox where the host allows it, and without it elsewhere", { timeout: 120_000 }, async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    await expect.poll(async () => (await server.client.screens.status({ botId: rex.id })).state, { timeout: 60_000 }).toBe('running')
    const display = (await connectScreens({ socketPath }).status(rex)).display!
    // The sandbox needs user namespaces, which some hosts' Docker keeps from containers (GitHub's Ubuntu runners do).
    let userNamespaces = true
    try {
      execFileSync('sudo', ['--non-interactive', `--user=${botUser}`, 'unshare', '--user', 'true'])
    } catch {
      userNamespaces = false
    }

    // Chrome's own report: sandboxed, its pages run in their own user namespace, with seccomp-bpf on top.
    const report = await pageText(9222 + display, 'chrome://sandbox', 'sandboxed')

    if (userNamespaces) {
      expect(report).toContain('You are adequately sandboxed.')
      expect(report).toMatch(/Layer 1 Sandbox\s+Namespace/)
    } else {
      expect(report).toContain('You are NOT adequately sandboxed.')
    }
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

  it('complete a browser task in their own Chrome through use_computer', { timeout: 120_000 }, async () => {
    const pages = await servePages()
    try {
      const socks = pages.page('socks', { title: 'Socks', elements: [{ role: 'heading', name: 'Socks' }, { role: 'text', name: 'Wool socks: $5' }] })
      const shop = pages.page('shop', { title: 'Shop', elements: [{ role: 'heading', name: 'Shop' }, { role: 'link', name: 'Socks', href: socks }] })
      const server = await start()
      const rex = await server.client.bots.create(newBot('Rex'))
      await expect.poll(async () => (await server.client.screens.status({ botId: rex.id })).state, { timeout: 60_000 }).toBe('running')
      server.providers.script(
        callsTools(['use_computer', { goal: 'Find the price of socks', reason: 'Testing the browser', startUrl: shop }]),
        callsTools(['browser_snapshot', {}]),
        // The link is the second element with a reference on the page's first snapshot.
        // Chrome's tree, as the fake's: the heading is e1, the link e2.
        callsTools(['browser_click', { ref: 'e2' }]),
        says('Wool socks cost $5.'),
        callsTools(['sendMessage', { text: 'Socks are $5' }]),
        endsSilently(),
      )

      await server.client.chats.send({ chatId: rex.chatId, text: 'How much are socks?' })
      await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === rex.id)?.working, { timeout: 60_000 }).toBe(false)

      const [, , snapshot, clicked, answered] = server.providers.requests.map((request) => JSON.stringify(request.messages.at(-1)))
      expect(snapshot).toContain('- heading \\"Shop\\" [ref=e1]\\n- link \\"Socks\\" [ref=e2]')
      expect(clicked).toContain('Wool socks: $5')
      expect(answered).toContain('Wool socks cost $5.')
      const saved = answered!.match(/saved at (\S+\.png)/)![1]!
      expect(statSync(saved).size).toBeGreaterThan(1000)
    } finally {
      await pages.close()
    }
  })

  it('operate a desktop app on their screen through use_computer, each action reporting its effect', { timeout: 120_000 }, async () => {
    const server = await start()
    const rex = await server.client.bots.create(newBot('Rex'))
    await expect.poll(async () => (await server.client.screens.status({ botId: rex.id })).state, { timeout: 60_000 }).toBe('running')
    // The window's id is only known once Mousepad is open, so the rest of the session is scripted then.
    const opened = held(callsTools(['desktop_windows', {}]))
    server.providers.script(
      callsTools(['use_computer', { goal: 'Write "Milk, eggs" in Mousepad', reason: 'Testing the desktop' }]),
      callsTools(['desktop_open', { app: 'mousepad' }]),
      opened,
    )

    await server.client.chats.send({ chatId: rex.chatId, text: 'Write my shopping list' })
    await opened.requested
    const open = JSON.stringify(server.providers.requests.at(-1)!.messages.at(-1))
    const window = Number(open.match(/- (\d+): Mousepad/)?.[1])
    server.providers.script(
      callsTools(['desktop_type', { windowId: window, text: 'Milk, eggs' }]),
      callsTools(['desktop_snapshot', { windowId: window }]),
      says('Mousepad now reads "Milk, eggs".'),
      callsTools(['sendMessage', { text: 'Done' }]),
      endsSilently(),
    )
    opened.release()
    await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === rex.id)?.working, { timeout: 60_000 }).toBe(false)

    // Each request's last message is the result of the call before it.
    const [, , , windows, typed, snapshot, answered] = server.providers.requests.map((request) => JSON.stringify(request.messages.at(-1)))
    expect(window).toBeGreaterThan(0)
    expect(windows).toMatch(/Mousepad/)
    expect(typed).toMatch(/Effect: (confirmed|unverifiable)\./)
    expect(snapshot).toMatch(/\[ref=d\d+\] text \\"Milk, eggs/)
    expect(answered).toContain('Mousepad now reads')
    expect(statSync(answered!.match(/saved at (\S+\.png)/)![1]!).size).toBeGreaterThan(1000)
  })

  it('ask the owner to take over when stuck, and go on once handed back', { timeout: 120_000 }, async () => {
    const pages = await servePages()
    try {
      const signIn = pages.page('sign-in', { title: 'Sign in', elements: [{ role: 'heading', name: 'Sign in' }, { role: 'textbox', name: 'Password' }] })
      const server = await start()
      const rex = await server.client.bots.create(newBot('Rex'))
      await expect.poll(async () => (await server.client.screens.status({ botId: rex.id })).state, { timeout: 60_000 }).toBe('running')
      const goal = { goal: 'Open my orders', reason: 'Testing take-over', startUrl: signIn }
      server.providers.script(
        callsTools(['use_computer', goal]),
        callsTools(['browser_snapshot', {}]),
        callsTools(['needs_help', { instruction: 'Sign in to the shop' }]),
      )
      await server.client.chats.send({ chatId: rex.chatId, text: 'What did I order?' })
      await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === rex.id)?.working, { timeout: 60_000 }).toBe(false)
      const card = (await server.client.chats.messages({ chatId: rex.chatId })).at(-1)!
      expect(card.card).toEqual({ type: 'take_over', instruction: 'Sign in to the shop', outcome: null })

      // The owner takes over, then is done: Rex's next session runs on the screen as they left it.
      server.providers.script(
        callsTools(['use_computer', { goal: 'Open my orders', reason: 'Testing take-over' }]),
        callsTools(['browser_snapshot', {}]),
        says('Still the sign-in page.'),
        callsTools(['sendMessage', { text: 'Done' }]),
        endsSilently(),
      )
      await server.client.chats.handBack({ messageId: card.id, outcome: 'done' })
      await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === rex.id)?.working, { timeout: 60_000 }).toBe(false)

      const resumed = server.providers.requests.map((request) => JSON.stringify(request.messages.at(-1)))
      expect(resumed[3]).toContain('The owner handed your screen back')
      expect(resumed[5]).toContain('- heading \\"Sign in\\"')
    } finally {
      await pages.close()
    }
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
