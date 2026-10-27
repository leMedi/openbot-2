import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { interruptedNote } from '@openbot/agent'
import { callsTools, endsSilently, held, says } from '@openbot/agent/testing'
import type { BotInfo, NewBot } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const profile = (name: string, title: string | null = null): NewBot => ({
  name,
  title,
  instructions: '',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
})

/** Rex and Ana, ready to run on the fake model. */
async function startWithTeam() {
  const server = await createTestServer()
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

    expect(await transcript(server, rex)).toEqual([
      ['You', null, 'Get PR 12 reviewed'],
      ['Rex', '→ Ana', 'Can you review PR 12?'],
      ['Rex', null, 'Asked Ana.'],
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

  it('carries files from the sender\'s computer, shown in both DMs and told to the recipient', async () => {
    const { server, rex, ana } = await startWithTeam()
    await mkdir(join(server.home, 'bots', rex.id), { recursive: true })
    await writeFile(join(server.home, 'bots', rex.id, 'diff.txt'), 'fix: pin pnpm\n')
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: 'Ana', text: 'Here is the diff', attachments: ['diff.txt'] }]),
      callsTools(['sendMessage', { text: 'Sent Ana the diff.' }]),
      endsSilently(),
    )
    server.providers.scriptFor('Ana', endsSilently())

    await server.client.chats.send({ chatId: rex.chatId, text: 'Send Ana the diff' })
    await untilIdle(server, rex, ana)

    const path = join(server.home, 'bots', rex.id, 'diff.txt')
    const [incoming] = await server.client.chats.messages({ chatId: ana.chatId })
    expect(incoming!.attachments).toMatchObject([{ name: 'diff.txt', mimeType: 'text/plain', path }])
    const outgoing = (await server.client.chats.messages({ chatId: rex.chatId }))[1]!
    expect(outgoing.attachments).toMatchObject([{ name: 'diff.txt', path }])
    const download = await server.fetch(`/api/messages/${incoming!.id}/attachments/${incoming!.attachments[0]!.id}`)
    expect(await download.text()).toBe('fix: pin pnpm\n')
    expect(lastMessage(requestsOf(server, 'Ana')[0]!)).toContain(`The sender attached a file, saved on your computer:\\n- ${path}`)
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

  it('never interrupts a run the owner steered, even one a bot started', async () => {
    const { server, rex, ana } = await startWithTeam()
    const digest = held(callsTools(['sendMessage', { text: 'Half a digest' }]))
    server.providers.scriptFor(
      'Ana',
      digest,
      // Steered: the owner's message joined the run, which goes on.
      callsTools(['sendMessage', { text: 'Digest, with the release.' }]),
      endsSilently(),
      // Then the priority message.
      endsSilently(),
    )
    server.providers.scriptFor('Rex', callsTools(['message_bot', { to: 'Ana', text: 'The build is down!', priority: true }]), endsSilently())

    await server.runtime.wake(ana.id, { lane: 'background', text: 'Write the daily digest', id: 'digest-1' })
    await digest.requested
    await server.client.chats.send({ chatId: ana.chatId, text: 'Also mention the release' })
    await server.runtime.wake(rex.id, { lane: 'bot', text: 'Warn Ana', id: 'warn-1' })
    await untilIdle(server, rex)
    digest.release()
    await untilIdle(server, ana)

    expect((await transcript(server, ana)).map(([, , text]) => text)).toEqual(['Also mention the release', 'The build is down!', 'Digest, with the release.'])
    const requests = requestsOf(server, 'Ana')
    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests.map(lastMessage))).not.toContain(interruptedNote)
    expect(lastMessage(requests[3]!)).toContain('The build is down!')
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('drops the queued messages when the owner stops it, keeping them in its DM', async () => {
    const { server, rex, ana } = await startWithTeam()
    const working = held(callsTools(['sendMessage', { text: 'Still writing…' }]))
    server.providers.scriptFor('Ana', working)
    server.providers.scriptFor('Rex', callsTools(['message_bot', { to: 'Ana', text: 'Lunch?' }]), endsSilently())

    await server.client.chats.send({ chatId: ana.chatId, text: 'Write the report' })
    await working.requested
    await server.runtime.wake(rex.id, { lane: 'bot', text: 'Ask Ana about lunch', id: 'lunch-1' })
    await untilIdle(server, rex)
    await server.client.bots.stop({ botId: ana.id })
    await untilIdle(server, ana)

    expect(requestsOf(server, 'Ana')).toHaveLength(1)
    expect(await transcript(server, ana)).toEqual([
      ['You', null, 'Write the report'],
      ['Rex', '← Rex', 'Lunch?'],
    ])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('drops work interrupted a second time', async () => {
    const { server, rex, ana } = await startWithTeam()
    const first = held(callsTools(['sendMessage', { text: 'Half a digest' }]))
    const again = held(callsTools(['sendMessage', { text: 'Half a digest, again' }]))
    server.providers.scriptFor('Ana', first, endsSilently(), again, endsSilently())
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
    expect(requests).toHaveLength(4)
    expect(lastMessage(requests[3]!)).toContain('The build is down again!')
    expect(await transcript(server, ana)).toEqual([
      ['Rex', '← Rex', 'The build is down!'],
      ['Rex', '← Rex', 'The build is down again!'],
    ])
    expect(server.providers.pendingTurns).toBe(0)
  })
})
