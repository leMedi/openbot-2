import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { interruptedNote, supersededNote } from '@openbot/agent'
import { callsTools, endsSilently, held, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer, type TestServerOptions } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** Restarts `server` on its data, as `restartTestServer` does, closing the new server after the test instead. */
async function restart(server: TestServer, options?: TestServerOptions) {
  const restarted = await restartTestServer(server, options)
  servers.splice(servers.indexOf(server), 1, restarted)
  return restarted
}

const profile = (name: string, title: string | null = null): NewBot => ({
  name,
  title,
  instructions: '',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
})

/** Rex and Ana, ready to run on the fake model. */
async function startWithTeam(options: TestServerOptions = {}) {
  const server = await createTestServer(options)
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const rex = await server.client.bots.create(profile('Rex', 'Builder'))
  const ana = await server.client.bots.create(profile('Ana', 'Reviewer'))
  return { server, rex, ana }
}

async function untilIdle(server: TestServer, ...bots: BotInfo[]) {
  for (const bot of bots) {
    await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
  }
}

/** What the DM shows: who posted, the bot message's direction and peer, and the text. */
const transcript = async (server: TestServer, bot: BotInfo) =>
  (await server.client.chats.messages({ chatId: bot.chatId })).map((message) => [
    message.authorName,
    message.botMessage ? `${message.botMessage.direction === 'to' ? '→' : '←'} ${message.botMessage.name}` : null,
    message.text,
  ])

/** The requests the bot's model got, in order. */
const requestsOf = (server: TestServer, name: string) =>
  server.providers.requests.filter((request) => JSON.stringify(request.messages).includes(`You are ${name}`))

/** The newest message a request ends with: the input or tool results the model answers. */
const lastMessage = (request: { messages: unknown[] }) => JSON.stringify(request.messages.at(-1))

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

/** The web, for bots' downloads: `pages` by URL, anything else not found. */
const web =
  (pages: Record<string, { type: string; body: BodyInit }>): typeof fetch =>
  async (input) => {
    const page = pages[String(input)]
    return page ? new Response(page.body, { headers: { 'content-type': page.type } }) : new Response('Not found', { status: 404 })
  }

describe('a bot messaging another bot', () => {
  it('shows the message in both DMs and wakes the recipient, who may stay silent', async () => {
    const { server, rex, ana } = await startWithTeam()
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: '@ana', text: 'Can you review PR 12?' }]),
      callsTools(['sendMessage', { text: 'Asked Ana to review it.' }]),
      endsSilently(),
    )
    server.providers.scriptFor('Ana', says('Private: I will look at it tomorrow.'))

    await server.client.chats.send({ chatId: rex.chatId, text: 'Get PR 12 reviewed' })
    await untilIdle(server, rex, ana)

    expect(await transcript(server, rex)).toEqual([
      ['You', null, 'Get PR 12 reviewed'],
      ['Rex', '→ Ana', 'Can you review PR 12?'],
      ['Rex', null, 'Asked Ana to review it.'],
    ])
    // Ana stayed silent: nothing posted, and no reminder to reply.
    expect(await transcript(server, ana)).toEqual([['Rex', '← Rex', 'Can you review PR 12?']])
    const [woken, ...more] = requestsOf(server, 'Ana')
    expect(more).toEqual([])
    expect(lastMessage(woken!)).toContain('Can you review PR 12?')
    expect(lastMessage(woken!)).toContain('Message from Rex')
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('returns at once, and the reply wakes the sender later', async () => {
    const { server, rex, ana } = await startWithTeam()
    const reviewing = held(callsTools(['message_bot', { to: 'Rex', text: 'Approved, ship it.' }]))
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: 'Ana', text: 'Can you review PR 12?' }], ['sendMessage', { text: 'Asked Ana.' }]),
      endsSilently(),
      // Woken by Ana's reply.
      callsTools(['sendMessage', { text: 'Ana approved PR 12.' }]),
      endsSilently(),
    )
    server.providers.scriptFor('Ana', reviewing, endsSilently())

    await server.client.chats.send({ chatId: rex.chatId, text: 'Get PR 12 reviewed' })
    await reviewing.requested
    // Rex's run ended while Ana was still reviewing.
    await untilIdle(server, rex)
    expect(JSON.stringify(requestsOf(server, 'Rex')[1]!.messages)).toMatch(/Sent to Ana. Don't wait for an answer/)
    reviewing.release()
    await untilIdle(server, ana, rex)

    const [sent, first, second, ...later] = await transcript(server, rex)
    expect(sent).toEqual(['You', null, 'Get PR 12 reviewed'])
    // Rex's two calls of one round run in parallel, as Grok's do, so they post in either order.
    expect([first, second]).toEqual(
      expect.arrayContaining([
        ['Rex', '→ Ana', 'Can you review PR 12?'],
        ['Rex', null, 'Asked Ana.'],
      ]),
    )
    expect(later).toEqual([
      ['Ana', '← Ana', 'Approved, ship it.'],
      ['Rex', null, 'Ana approved PR 12.'],
    ])
    expect(await transcript(server, ana)).toEqual([
      ['Rex', '← Rex', 'Can you review PR 12?'],
      ['Ana', '→ Rex', 'Approved, ship it.'],
    ])
    expect(lastMessage(requestsOf(server, 'Rex')[2]!)).toContain('Approved, ship it.')
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('rejects messages to itself, to unknown bots and over 8,000 characters, posting nothing', async () => {
    const { server, rex, ana } = await startWithTeam()
    server.providers.scriptFor(
      'Rex',
      callsTools(
        ['message_bot', { to: 'rex', text: 'Note to self' }],
        ['message_bot', { to: 'Zed', text: 'Hello?' }],
        ['message_bot', { to: 'Ana', text: 'x'.repeat(8_001) }],
      ),
      callsTools(['sendMessage', { text: 'Could not reach anyone.' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: rex.chatId, text: 'Ping the team' })
    await untilIdle(server, rex)

    const results = JSON.stringify(requestsOf(server, 'Rex')[1]!.messages.slice(-3))
    expect(results).toContain("You can't message yourself")
    expect(results).toContain('There is no bot or group chat named Zed')
    expect(results).toContain('Your teammates are Ana.')
    expect(results).toContain('at most 8000 characters')
    expect(await transcript(server, rex)).toEqual([
      ['You', null, 'Ping the team'],
      ['Rex', null, 'Could not reach anyone.'],
    ])
    expect(await transcript(server, ana)).toEqual([])
    expect(requestsOf(server, 'Ana')).toEqual([])
  })

  it("leaves both DMs read: messages between bots aren't for the owner", async () => {
    const { server, rex, ana } = await startWithTeam()
    server.providers.scriptFor('Rex', callsTools(['message_bot', { to: 'Ana', text: 'Lunch?' }]), endsSilently())
    server.providers.scriptFor('Ana', callsTools(['message_bot', { to: 'Rex', text: 'Sure, noon.' }]), endsSilently(), endsSilently())

    await server.runtime.wake(rex.id, { lane: 'bot', text: 'Ask Ana about lunch', id: 'lunch-1' })
    await untilIdle(server, rex, ana, rex)

    expect(await transcript(server, ana)).toEqual([
      ['Rex', '← Rex', 'Lunch?'],
      ['Ana', '→ Rex', 'Sure, noon.'],
    ])
    const chats = await server.client.chats.list()
    expect(chats.map((chat) => [chat.botId, chat.unread])).toEqual([
      [rex.id, false],
      [ana.id, false],
    ])
  })

  it("carries images, from the sender's computer and the web, shown in both DMs and seen by the recipient", async () => {
    const { server, rex, ana } = await startWithTeam({ fetch: web({ 'https://example.com/chart': { type: 'image/png', body: pixel } }) })
    await mkdir(join(server.home, 'bots', rex.id), { recursive: true })
    await writeFile(join(server.home, 'bots', rex.id, 'screen.png'), pixel)
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: 'Ana', text: 'The page and the chart', images: ['screen.png', 'https://example.com/chart'] }]),
      callsTools(['sendMessage', { text: 'Sent Ana both.' }]),
      endsSilently(),
    )
    server.providers.scriptFor('Ana', endsSilently())

    await server.client.chats.send({ chatId: rex.chatId, text: 'Show Ana' })
    await untilIdle(server, rex, ana)

    const screen = join(server.home, 'bots', rex.id, 'screen.png')
    // Downloaded where the files the owner sends Ana go.
    const chart = join(server.home, 'bots', ana.id, 'uploads', 'chart.png')
    const files = [
      { name: 'screen.png', mimeType: 'image/png', path: screen },
      { name: 'chart.png', mimeType: 'image/png', path: chart },
    ]
    const [incoming] = await server.client.chats.messages({ chatId: ana.chatId })
    expect(incoming!.attachments).toMatchObject(files)
    expect((await server.client.chats.messages({ chatId: rex.chatId }))[1]!.attachments).toMatchObject(files)
    const download = await server.fetch(`/api/messages/${incoming!.id}/attachments/${incoming!.attachments[1]!.id}`)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(pixel)
    const input = requestsOf(server, 'Ana')[0]!.messages.at(-1)!
    const images = (input.content as Exclude<typeof input.content, string>).filter((part) => part.type === 'image')
    expect(images).toEqual([
      { type: 'image', mimeType: 'image/png', data: pixel.toString('base64') },
      { type: 'image', mimeType: 'image/png', data: pixel.toString('base64') },
    ])
  })

  it('refuses anything but images, and downloads that fail, posting nothing', async () => {
    const { server, rex, ana } = await startWithTeam({ fetch: web({ 'https://example.com/page': { type: 'text/html', body: '<p>Hi</p>' } }) })
    await mkdir(join(server.home, 'bots', rex.id), { recursive: true })
    await writeFile(join(server.home, 'bots', rex.id, 'diff.txt'), 'fix: pin pnpm\n')
    server.providers.scriptFor(
      'Rex',
      callsTools(
        ['message_bot', { to: 'Ana', text: 'The diff', images: ['diff.txt'] }],
        ['message_bot', { to: 'Ana', text: 'The page', images: ['https://example.com/page'] }],
        ['message_bot', { to: 'Ana', text: 'The chart', images: ['https://example.com/gone.png'] }],
        ['message_bot', { to: 'Ana', text: 'Over HTTP', images: ['http://example.com/chart.png'] }],
      ),
      callsTools(['sendMessage', { text: 'Could not send Ana anything.' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: rex.chatId, text: 'Send Ana the diff' })
    await untilIdle(server, rex)

    const results = JSON.stringify(requestsOf(server, 'Rex')[1]!.messages.slice(-4))
    expect(results).toContain("diff.txt isn't an image: message_bot only carries images")
    expect(results).toContain(join(server.home, 'shared'))
    expect(results).toContain("https://example.com/page isn't an image (text/html)")
    expect(results).toContain("Couldn't download https://example.com/gone.png: HTTP 404")
    expect(results).toContain('an image is a file on your computer or an https:// URL')
    expect(await transcript(server, rex)).toEqual([
      ['You', null, 'Send Ana the diff'],
      ['Rex', null, 'Could not send Ana anything.'],
    ])
    expect(await transcript(server, ana)).toEqual([])
    expect(requestsOf(server, 'Ana')).toEqual([])
  })

  it('lists the teammates in the prompt, with the rules for messaging them', async () => {
    const { server, rex } = await startWithTeam()
    server.providers.scriptFor('Rex', callsTools(['sendMessage', { text: 'Hi' }]), endsSilently())

    await server.client.chats.send({ chatId: rex.chatId, text: 'Hello' })
    await untilIdle(server, rex)

    const [request] = requestsOf(server, 'Rex')
    expect(request!.tools).toContain('message_bot')
    const prompt = JSON.stringify(request!.messages)
    expect(prompt).toContain('- Ana, Reviewer')
    expect(prompt).not.toContain('- Rex, Builder')
    expect(prompt).toMatch(/sparingly/)
    expect(prompt).toMatch(/verbatim/)
    expect(prompt).toMatch(/acknowledg/)
  })
})

describe('waking a busy bot', () => {
  it('queues messages behind its run, a priority one first', async () => {
    const { server, rex, ana } = await startWithTeam()
    const working = held(callsTools(['sendMessage', { text: 'Working on your report.' }]))
    server.providers.scriptFor('Ana', working, endsSilently(), endsSilently(), endsSilently())
    server.providers.scriptFor(
      'Rex',
      callsTools(
        ['message_bot', { to: 'Ana', text: 'When you have a minute: lunch?' }],
        ['message_bot', { to: 'Ana', text: 'The build is down!', priority: true }],
      ),
      callsTools(['sendMessage', { text: 'Told Ana.' }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: ana.chatId, text: 'Write the report' })
    await working.requested
    await server.client.chats.send({ chatId: rex.chatId, text: 'Tell Ana' })
    await untilIdle(server, rex)
    working.release()
    await untilIdle(server, ana)

    // The owner's run was never interrupted.
    expect((await transcript(server, ana)).map(([, , text]) => text)).toContain('Working on your report.')
    const [, , priority, queued] = requestsOf(server, 'Ana')
    expect(lastMessage(priority!)).toContain('The build is down!')
    expect(lastMessage(queued!)).toContain('lunch?')
    expect(server.providers.pendingTurns).toBe(0)
  })

  it.each(['bot', 'background'] as const)('interrupts its %s-lane run with a priority message, then redelivers that work once', async (lane) => {
    const { server, rex, ana } = await startWithTeam()
    const digest = held(callsTools(['sendMessage', { text: 'Half a digest' }]))
    server.providers.scriptFor('Ana', digest, endsSilently(), endsSilently())
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: 'Ana', text: 'The build is down!', priority: true }]),
      callsTools(['sendMessage', { text: 'Told Ana.' }]),
      endsSilently(),
    )

    await server.runtime.wake(ana.id, { lane, text: 'Write the daily digest', id: 'digest-1' })
    await digest.requested
    await server.client.chats.send({ chatId: rex.chatId, text: 'Tell Ana' })
    await untilIdle(server, rex, ana)

    // The interrupted run posted nothing.
    expect(await transcript(server, ana)).toEqual([['Rex', '← Rex', 'The build is down!']])
    const [, priority, redelivered, ...more] = requestsOf(server, 'Ana')
    expect(lastMessage(priority!)).toContain('The build is down!')
    expect(lastMessage(redelivered!)).toContain('Write the daily digest')
    expect(lastMessage(redelivered!)).toContain(interruptedNote)
    expect(more).toEqual([])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it("is interrupted by the owner's message, and its work runs again after it; a priority message never interrupts the owner's run", async () => {
    const { server, rex, ana } = await startWithTeam()
    const digest = held(callsTools(['sendMessage', { text: 'Half a digest' }]))
    const reply = held(callsTools(['sendMessage', { text: 'Release noted.' }]))
    server.providers.scriptFor(
      'Ana',
      digest,
      reply,
      endsSilently(),
      // The priority message, then the digest again.
      endsSilently(),
      callsTools(['sendMessage', { text: 'Digest, with the release.' }]),
      endsSilently(),
    )
    server.providers.scriptFor('Rex', callsTools(['message_bot', { to: 'Ana', text: 'The build is down!', priority: true }]), endsSilently())

    await server.runtime.wake(ana.id, { lane: 'background', text: 'Write the daily digest', id: 'digest-1' })
    await digest.requested
    await server.client.chats.send({ chatId: ana.chatId, text: 'Also mention the release' })
    await reply.requested
    await server.runtime.wake(rex.id, { lane: 'bot', text: 'Warn Ana', id: 'warn-1' })
    await untilIdle(server, rex)
    reply.release()
    await untilIdle(server, ana)

    expect((await transcript(server, ana)).map(([, , text]) => text)).toEqual([
      'Also mention the release',
      'The build is down!',
      'Release noted.',
      'Digest, with the release.',
    ])
    const requests = requestsOf(server, 'Ana')
    expect(requests).toHaveLength(6)
    expect(lastMessage(requests[1]!)).toContain('Also mention the release')
    expect(lastMessage(requests[3]!)).toContain('The build is down!')
    expect(lastMessage(requests[4]!)).toContain('Write the daily digest')
    expect(lastMessage(requests[4]!)).toContain(interruptedNote)
    expect(server.providers.pendingTurns).toBe(0)
  })

  it("delivers the work queued behind a run the owner's message interrupts, in lane order", async () => {
    const { server, rex, ana } = await startWithTeam()
    const working = held(callsTools(['sendMessage', { text: 'Still writing…' }]))
    server.providers.scriptFor(
      'Ana',
      working,
      callsTools(['sendMessage', { text: 'Summary ready.' }]),
      endsSilently(),
      // Rex's message, then the routine.
      endsSilently(),
      endsSilently(),
    )
    server.providers.scriptFor('Rex', callsTools(['message_bot', { to: 'Ana', text: 'Lunch?' }]), endsSilently())

    await server.client.chats.send({ chatId: ana.chatId, text: 'Write the report' })
    await working.requested
    await server.runtime.wake(ana.id, { lane: 'background', text: 'Write the daily digest', id: 'digest-1' })
    await server.runtime.wake(rex.id, { lane: 'bot', text: 'Ask Ana about lunch', id: 'lunch-1' })
    await untilIdle(server, rex)
    await server.client.chats.send({ chatId: ana.chatId, text: 'Actually, just summarise it' })
    await untilIdle(server, ana)

    expect(await transcript(server, ana)).toEqual([
      ['You', null, 'Write the report'],
      ['Rex', '← Rex', 'Lunch?'],
      ['You', null, 'Actually, just summarise it'],
      ['Ana', null, 'Summary ready.'],
    ])
    const requests = requestsOf(server, 'Ana')
    expect(requests).toHaveLength(5)
    expect(lastMessage(requests[1]!)).toContain(supersededNote)
    expect(lastMessage(requests[3]!)).toContain('Lunch?')
    expect(lastMessage(requests[4]!)).toContain('Write the daily digest')
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('wakes the bot after a restart for a message that was queued, exactly once', async () => {
    const { server: before, rex, ana } = await startWithTeam()
    const working = held(callsTools(['sendMessage', { text: 'Working on your report.' }]))
    before.providers.scriptFor('Ana', working)
    before.providers.scriptFor('Rex', callsTools(['message_bot', { to: 'Ana', text: 'Lunch?' }]), endsSilently())
    await before.client.chats.send({ chatId: ana.chatId, text: 'Write the report' })
    await working.requested
    await before.runtime.wake(rex.id, { lane: 'bot', text: 'Ask Ana about lunch', id: 'lunch-1' })
    await untilIdle(before, rex)

    const after = await restart(before, {
      // Her run for the owner goes on, then Rex's message wakes her.
      script: (providers) => providers.scriptFor('Ana', callsTools(['sendMessage', { text: 'Report done.' }]), endsSilently(), endsSilently()),
    })
    await untilIdle(after, ana)
    const [incoming] = (await after.client.chats.messages({ chatId: ana.chatId })).filter((message) => message.botMessage)
    // A replayed message_bot call wakes her with the same input again.
    await after.runtime.wake(ana.id, { lane: 'bot', text: 'Lunch?', id: incoming!.id })
    await untilIdle(after, ana)

    const woken = requestsOf(after, 'Ana').filter((request) => lastMessage(request).includes('Message from Rex'))
    expect(woken).toHaveLength(1)
    expect(lastMessage(woken[0]!)).toContain('Lunch?')
    // The resumed run answered the owner while Rex's message waited for it.
    expect((await transcript(after, ana)).map(([, , text]) => text)).toEqual(['Write the report', 'Lunch?', 'Report done.'])
    expect(after.providers.pendingTurns).toBe(0)
  })

  it('runs work an interrupt queued again after a restart, once', async () => {
    const { server: before, rex, ana } = await startWithTeam()
    const digest = held(callsTools(['sendMessage', { text: 'Half a digest' }]))
    const warned = held(endsSilently())
    before.providers.scriptFor('Ana', digest, warned)
    before.providers.scriptFor('Rex', callsTools(['message_bot', { to: 'Ana', text: 'The build is down!', priority: true }]), endsSilently())
    await before.runtime.wake(ana.id, { lane: 'background', text: 'Write the daily digest', id: 'digest-1' })
    await digest.requested
    await before.runtime.wake(rex.id, { lane: 'bot', text: 'Warn Ana', id: 'warn-1' })
    await warned.requested

    const after = await restart(before, {
      // The priority message's run goes on, then the digest runs again.
      script: (providers) => providers.scriptFor('Ana', endsSilently(), callsTools(['sendMessage', { text: 'Digest.' }]), endsSilently()),
    })
    await untilIdle(after, ana)
    // A routine waking her again with the same input finds it was queued already.
    await after.runtime.wake(ana.id, { lane: 'background', text: 'Write the daily digest', id: 'digest-1' })
    await untilIdle(after, ana)

    const digests = requestsOf(after, 'Ana').filter((request) => lastMessage(request).includes('Write the daily digest'))
    expect(digests).toHaveLength(1)
    expect(lastMessage(digests[0]!)).toContain(interruptedNote)
    expect(await transcript(after, ana)).toEqual([
      ['Rex', '← Rex', 'The build is down!'],
      ['Ana', null, 'Digest.'],
    ])
    expect(after.providers.pendingTurns).toBe(0)
  })

  it('runs work again however often it is interrupted', async () => {
    const { server, rex, ana } = await startWithTeam()
    const first = held(callsTools(['sendMessage', { text: 'Half a digest' }]))
    const again = held(callsTools(['sendMessage', { text: 'Half a digest, again' }]))
    server.providers.scriptFor('Ana', first, endsSilently(), again, endsSilently(), endsSilently())
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: 'Ana', text: 'The build is down!', priority: true }]),
      endsSilently(),
      callsTools(['message_bot', { to: 'Ana', text: 'The build is down again!', priority: true }]),
      endsSilently(),
    )

    await server.runtime.wake(ana.id, { lane: 'background', text: 'Write the daily digest', id: 'digest-1' })
    await first.requested
    await server.runtime.wake(rex.id, { lane: 'bot', text: 'Warn Ana', id: 'warn-1' })
    await again.requested
    await server.runtime.wake(rex.id, { lane: 'bot', text: 'Warn Ana again', id: 'warn-2' })
    await untilIdle(server, rex, ana)

    const requests = requestsOf(server, 'Ana')
    expect(requests).toHaveLength(5)
    expect(lastMessage(requests[3]!)).toContain('The build is down again!')
    expect(lastMessage(requests[4]!)).toContain('Write the daily digest')
    expect(lastMessage(requests[4]!)).toContain(interruptedNote)
    expect(await transcript(server, ana)).toEqual([
      ['Rex', '← Rex', 'The build is down!'],
      ['Rex', '← Rex', 'The build is down again!'],
    ])
    expect(server.providers.pendingTurns).toBe(0)
  })
})
