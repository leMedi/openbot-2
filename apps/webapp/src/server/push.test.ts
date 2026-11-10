import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer, type TestServerOptions } from './testing/harness.ts'
import { closePluginFixtures, hostedPlugin, writeCatalog } from './testing/plugins.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await closePluginFixtures()
})

const rex: NewBot = { name: 'Rex', title: 'Builder', instructions: '', avatarShape: 'hex', avatarColor: 'blue', model: null }

/** A 1×1 PNG. */
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const iphone = { expoPushToken: 'ExponentPushToken[iphone-aaaa]', name: "Mehdi's iPhone", platform: 'ios' as const }
const pixel = { expoPushToken: 'ExponentPushToken[pixel-bbbb]', name: 'Pixel 9', platform: 'android' as const }

/** A finished onboarding with Rex, and the owner's iPhone registered. */
async function startWithRex(options: TestServerOptions = {}) {
  const server = await createTestServer(options)
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bot = await server.client.bots.create(rex)
  const phone = await server.client.devices.register(iphone)
  return { server, bot, phone }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** The owner writes to the bot, which runs `turns`; resolves once its run ended and its pushes went out. */
async function ownerAsks(server: TestServer, bot: BotInfo, text: string, ...turns: Parameters<TestServer['providers']['script']>) {
  server.providers.script(...turns)
  await server.client.chats.send({ chatId: bot.chatId, text })
  await untilIdle(server, bot)
  await server.push.idle()
}

describe('push notifications', () => {
  it("push a bot's first message in a turn, then replace it quietly with the turn's later ones", async () => {
    const { server, bot } = await startWithRex()

    await ownerAsks(
      server,
      bot,
      'Fix the build',
      callsTools(['sendMessage', { text: 'On it!' }]),
      callsTools(['sendMessage', { text: 'Fixed: the **lockfile** was stale.' }]),
      endsSilently(),
    )

    const [first, second] = server.expoPush.messages
    expect(server.expoPush.messages).toHaveLength(2)
    expect(first).toMatchObject({ to: iphone.expoPushToken, title: 'Rex', body: 'On it!', sound: 'default', collapseId: bot.chatId, mutableContent: true })
    expect(first).not.toHaveProperty('interruptionLevel')
    // iOS replaces the line silently only as a passive notification: no banner, no sound, the screen left dark.
    expect(second).toMatchObject({ to: iphone.expoPushToken, title: 'Rex', body: 'Fixed: the lockfile was stale.', collapseId: bot.chatId, mutableContent: true, interruptionLevel: 'passive' })
    expect(second).not.toHaveProperty('sound')
    expect([first!.data.quiet, second!.data.quiet]).toEqual([false, true])

    // The next turn notifies again, with a sound.
    await ownerAsks(server, bot, 'Thanks, and the tests?', callsTools(['sendMessage', { text: 'All green.' }]), endsSilently())
    expect(server.expoPush.messages.at(-1)).toMatchObject({ body: 'All green.', sound: 'default' })
  })

  it('send title, preview, data and badge: the chats unread or with a card waiting', async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })
    await ownerAsks(server, ana, 'Hi Ana', callsTools(['sendMessage', { text: 'Hello!' }]), endsSilently())
    const long = `Here is [the report](https://example.com/r) with \`code\` and ${'very '.repeat(60)}long text.`

    await ownerAsks(server, bot, 'Report?', callsTools(['sendMessage', { text: long }]), endsSilently())

    const pushed = server.expoPush.messages.at(-1)!
    const message = (await server.messages(bot.chatId)).at(-1)!
    expect(pushed).toMatchObject({ title: 'Rex', data: { chatId: bot.chatId, messageId: message.id, kind: 'message', botId: bot.id, botName: 'Rex', group: false, quiet: false }, badge: 2 })
    expect(pushed.body.startsWith('Here is the report with code and very very')).toBe(true)
    expect(Array.from(pushed.body)).toHaveLength(200)
    expect(pushed.body.endsWith('…')).toBe(true)

    // Reading Ana's chat leaves one.
    await server.client.chats.read({ chatId: ana.chatId })
    await ownerAsks(server, bot, 'Thanks', callsTools(['sendMessage', { text: 'Anytime.' }]), endsSilently())
    expect(server.expoPush.messages.at(-1)).toMatchObject({ body: 'Anytime.', badge: 1 })
  })

  it('preview a message of files alone as "📷 Photo" or "📎 its name"', async () => {
    const { server, bot } = await startWithRex()
    await mkdir(join(server.home, 'shared'), { recursive: true })
    await writeFile(join(server.home, 'shared', 'pixel.png'), png)
    await writeFile(join(server.home, 'shared', 'report.pdf'), '%PDF-1.4')

    await ownerAsks(server, bot, 'Show me', callsTools(['sendMessage', { text: '', attachments: [join(server.home, 'shared', 'pixel.png')] }]), endsSilently())
    await ownerAsks(server, bot, 'And the report', callsTools(['sendMessage', { text: '', attachments: [join(server.home, 'shared', 'report.pdf')] }]), endsSilently())

    expect(server.expoPush.messages.map((message) => message.body)).toEqual(['📷 Photo', '📎 report.pdf'])
  })

  it("push a card that starts waiting with its prompt, with a sound even mid-turn, and don't push a routine change row", async () => {
    const { server, bot } = await startWithRex()

    await ownerAsks(
      server,
      bot,
      'Set up storage',
      callsTools(['sendMessage', { text: 'Let me check one thing.' }]),
      callsTools(['askQuestion', { prompt: 'Which **database**?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }]),
    )
    const card = (await server.messages(bot.chatId)).at(-1)!
    expect(server.expoPush.messages.at(-1)).toMatchObject({
      title: 'Rex',
      body: 'Which database?',
      sound: 'default',
      collapseId: bot.chatId,
      mutableContent: true,
      data: { chatId: bot.chatId, messageId: card.id, kind: 'question' },
      badge: 1,
    })
    // Read, the chat still counts in the badge while its card waits.
    await server.client.chats.read({ chatId: bot.chatId })
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })
    await ownerAsks(server, ana, 'Hi Ana', callsTools(['sendMessage', { text: 'Hello!' }]), endsSilently())
    expect(server.expoPush.messages.at(-1)).toMatchObject({ title: 'Ana', badge: 2 })

    const before = server.expoPush.messages.length
    await ownerAsks(
      server,
      bot,
      'SQLite. Also remind me daily at 9 to stretch',
      callsTools(['update_state', { target: 'routine', action: 'create', name: 'Stretch', schedule: '0 9 * * *', prompt: 'Remind the owner to stretch.' } as never]),
      endsSilently(),
    )
    expect((await server.messages(bot.chatId)).some((message) => message.card?.type === 'routine_change')).toBe(true)
    expect(server.expoPush.messages.length).toBe(before)
  })

  it("push a take-over card with its instruction", async () => {
    const login = 'https://shop.test/login'
    const { server, bot } = await startWithRex({ pages: { [login]: { title: 'Sign in', elements: [{ role: 'textbox', name: 'Password' }] } } })
    const goal = { goal: 'Open my orders on shop.test', reason: 'The shop needs a signed-in browser', startUrl: login }

    await ownerAsks(
      server,
      bot,
      'What did I order last?',
      callsTools(['use_computer', goal]),
      callsTools(['browser_snapshot', {}]),
      callsTools(['needs_help', { instruction: 'Sign in to *shop.test*' }]),
    )

    const card = (await server.messages(bot.chatId)).at(-1)!
    expect(server.expoPush.messages.at(-1)).toMatchObject({ body: 'Sign in to shop.test', sound: 'default', data: { messageId: card.id, kind: 'take_over' } })
  })

  it('push a plugin request card with its text', async () => {
    const { plugin: notes } = await hostedPlugin('notes')
    const { server, bot } = await startWithRex({ catalog: await writeCatalog({ notes }) })

    await ownerAsks(server, bot, 'Find my trip notes', callsTools(['request_plugin', { plugin: 'notes', reason: 'To find your **trip** notes' }]))

    const card = (await server.messages(bot.chatId)).at(-1)!
    expect(card.card?.type).toBe('plugin_request')
    expect(server.expoPush.messages.at(-1)).toMatchObject({ body: 'Wants to use Notes: To find your trip notes', sound: 'default', data: { messageId: card.id, kind: 'plugin_request' } })
  })

  it("don't push a muted or hidden chat's messages, but still push its cards", async () => {
    const { server, bot } = await startWithRex()
    await server.client.chats.mute({ chatIds: [bot.chatId], duration: '1h' })

    await ownerAsks(server, bot, 'Fix it', callsTools(['sendMessage', { text: 'On it!' }]), endsSilently())
    expect(server.expoPush.messages).toEqual([])
    await ownerAsks(server, bot, 'Which one?', callsTools(['askQuestion', { prompt: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }]))
    expect(server.expoPush.messages.map((message) => message.body)).toEqual(['Which branch?'])

    // Once the mute ends, messages notify again.
    await server.clock.advance(60 * 60_000)
    await ownerAsks(server, bot, 'main', callsTools(['sendMessage', { text: 'Done on main.' }]), endsSilently())
    expect(server.expoPush.messages.at(-1)?.body).toBe('Done on main.')

    // A hidden chat counts as muted.
    await server.client.chats.hide({ chatIds: [bot.chatId] })
    await ownerAsks(server, bot, 'Thanks', callsTools(['sendMessage', { text: 'Anytime.' }]), endsSilently())
    expect(server.expoPush.messages.at(-1)?.body).toBe('Done on main.')
    await ownerAsks(server, bot, 'Next?', callsTools(['askQuestion', { prompt: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }]))
    expect(server.expoPush.messages.at(-1)?.body).toBe('Deploy now?')
  })

  it('push nothing for a chat with a fresh viewing heartbeat, and push again once it goes stale', async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })
    await server.client.chats.viewing({ chatId: bot.chatId })

    await ownerAsks(server, bot, 'Fix it', callsTools(['sendMessage', { text: 'On it!' }]), endsSilently())
    await ownerAsks(server, bot, 'Which?', callsTools(['askQuestion', { prompt: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }]))
    // Other chats still notify.
    await ownerAsks(server, ana, 'Hi', callsTools(['sendMessage', { text: 'Hello!' }]), endsSilently())
    expect(server.expoPush.messages.map((message) => message.title)).toEqual(['Ana'])

    await server.clock.advance(45_000)
    await ownerAsks(server, bot, 'main', callsTools(['sendMessage', { text: 'Done.' }]), endsSilently())
    expect(server.expoPush.messages.map((message) => message.body)).toEqual(['Hello!', 'Done.'])
  })

  it('never push messages between bots', async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })
    server.providers.script(callsTools(['message_bot', { to: 'Ana', text: 'Can you review PR 12?' }]), endsSilently(), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: 'Get Ana to review it' })
    await untilIdle(server, bot)
    await untilIdle(server, ana)
    await server.push.idle()

    expect((await server.messages(ana.chatId)).map((message) => message.text)).toContain('Can you review PR 12?')
    expect(server.expoPush.messages).toEqual([])
  })

  it('title a group chat with its name, preview "Rex: …", and push each member\'s turn', async () => {
    const { server, bot } = await startWithRex()
    const ana = await server.client.bots.create({ ...rex, name: 'Ana' })
    server.providers.script(callsTools(['sendMessage', { text: 'Morning!' }]), endsSilently(), callsTools(['sendMessage', { text: 'Hi all.' }]), endsSilently())
    for (let round = 0; round < 4; round++) server.providers.script(endsSilently())

    const { chat } = await server.client.groups.create({ memberIds: [bot.id, ana.id], text: 'Morning, team' })
    await server.rounds.idle(chat.id)
    await server.push.idle()

    const pushed = server.expoPush.messages.filter((message) => message.data.chatId === chat.id)
    // Whichever member goes first, each turn notifies with a sound.
    expect(pushed.map(({ title, body, sound }) => ({ title, body, sound })).sort((a, b) => a.body.localeCompare(b.body))).toEqual([
      { title: 'Rex, Ana', body: expect.stringMatching(/^(Rex|Ana): Hi all\.$/), sound: 'default' },
      { title: 'Rex, Ana', body: expect.stringMatching(/^(Rex|Ana): Morning!$/), sound: 'default' },
    ])
    expect(new Set(pushed.map((message) => message.body.split(':')[0]))).toEqual(new Set(['Rex', 'Ana']))
    // The sender rides along, for the phone to show as the speaker.
    for (const message of pushed) expect(message.body.startsWith(`${message.data.botName}: `)).toBe(true)
    expect(pushed.every((message) => message.data.group && [bot.id, ana.id].includes(message.data.botId))).toBe(true)
  })

  it("follow each phone's switches: Messages for messages, When a bot needs you for cards", async () => {
    const { server, bot, phone } = await startWithRex()
    await server.client.devices.register(pixel)
    await server.client.devices.setSwitches({ deviceId: phone.id, messages: false })

    await ownerAsks(server, bot, 'Fix it', callsTools(['sendMessage', { text: 'On it!' }]), endsSilently())
    expect(server.expoPush.messages.map((message) => message.to)).toEqual([pixel.expoPushToken])

    await server.client.devices.setSwitches({ deviceId: phone.id, messages: true, needsYou: false })
    const android = (await server.client.devices.list()).find((device) => device.name === pixel.name)!
    await server.client.devices.setSwitches({ deviceId: android.id, needsYou: false })
    await ownerAsks(server, bot, 'Which?', callsTools(['askQuestion', { prompt: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }]))
    expect(server.expoPush.messages).toHaveLength(1)
  })

  it('drop phones Expo reports as not registered, from tickets at once and from receipts about 15 minutes later', async () => {
    const { server, bot } = await startWithRex()
    await server.client.devices.register(pixel)
    const ipad = await server.client.devices.register({ expoPushToken: 'ExponentPushToken[ipad-cccc]', name: 'iPad', platform: 'ios' })
    server.expoPush.failAtSend(pixel.expoPushToken)
    server.expoPush.failInReceipt(iphone.expoPushToken)

    await ownerAsks(server, bot, 'Fix it', callsTools(['sendMessage', { text: 'On it!' }]), endsSilently())
    expect((await server.client.devices.list()).map((device) => device.name)).toEqual([iphone.name, 'iPad'])
    expect(server.expoPush.receiptRequests).toEqual([])

    await server.clock.advance(15 * 60_000)
    expect(server.expoPush.receiptRequests).toEqual([['ticket-1', 'ticket-2']])
    expect(await server.client.devices.list()).toEqual([ipad])
  })

  it('send at most 100 notifications per request, with the access token when one is set', async () => {
    const { server, bot } = await startWithRex({ expoAccessToken: 'expo-secret' })
    for (let index = 0; index < 100; index++) {
      await server.client.devices.register({ expoPushToken: `ExponentPushToken[phone-${index}]`, name: `Phone ${index}`, platform: 'android' })
    }

    await ownerAsks(server, bot, 'Fix it', callsTools(['sendMessage', { text: 'On it!' }]), endsSilently())

    expect(server.expoPush.requests.map((request) => request.length)).toEqual([100, 1])
    expect(server.expoPush.headers.map((headers) => headers.get('authorization'))).toEqual(['Bearer expo-secret', 'Bearer expo-secret'])
  })
})
