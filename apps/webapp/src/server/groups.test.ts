import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { interruptedNote } from '@openbot/agent'
import { callsTools, endsSilently, held } from '@openbot/agent/testing'
import { type BotInfo, type ChatInfo, maxGroupMembers, minGroupMembers, type NewBot } from '@openbot/api-contract'
import { groupRoundRules } from '@openbot/core'
import { messages } from '@openbot/db'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const profile = (name: string): NewBot => ({
  name,
  title: null,
  instructions: '',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
})

/** A server with these bots, ready to run on the fake model. */
async function startWith(...names: string[]) {
  const server = await createTestServer()
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bots: BotInfo[] = []
  for (const name of names) bots.push(await server.client.bots.create(profile(name)))
  return { server, bots }
}

const textFile = (name: string, content: string) => new File([content], name, { type: 'text/plain' })

/** A member's turn in which it posts `text`. */
const posts = (text: string) => [callsTools(['sendMessage', { text }]), endsSilently()]
/** A member's turn in which it passes. */
const passes = () => [endsSilently()]

/** The owner creates a group of `members` with `text` and waits for the members' rounds to end. */
async function createGroup(server: TestServer, members: BotInfo[], text: string) {
  const { chat } = await server.client.groups.create({ memberIds: members.map((bot) => bot.id), text })
  await server.rounds.idle(chat.id)
  return chat
}

/** The owner posts `text` in the group and waits for the members' rounds to end. */
async function say(server: TestServer, chatId: string, text: string) {
  await server.client.chats.send({ chatId, text })
  await server.rounds.idle(chatId)
}

/** Who posted what in the chat. */
const transcript = async (server: TestServer, chatId: string) =>
  (await server.client.chats.messages({ chatId })).map((message) => `${message.authorName}: ${message.text}`)

/** The bots whose model was asked, in order: one entry per member turn's first request, given the scripts above. */
const speakers = (server: TestServer) =>
  server.providers.requests.map((request) => /You are (\w+)\./.exec(JSON.stringify(request.messages))![1])

/** The requests the bot's model got, in order. */
const requestsOf = (server: TestServer, name: string) =>
  server.providers.requests.filter((request) => JSON.stringify(request.messages).includes(`You are ${name}`))

/** The newest message a request ends with: the input or tool results the model answers. */
const lastMessage = (request: { messages: unknown[] }) => JSON.stringify(request.messages.at(-1))

const chatInfo = async (server: TestServer, chatId: string): Promise<ChatInfo> =>
  (await server.client.chats.list()).find((chat) => chat.id === chatId)!

describe('creating a group chat', () => {
  it('creates it with its first message, named after its members, and lists it in the sidebar', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())

    const chat = await createGroup(server, [rex!, ana!], 'Morning, team')

    expect(chat).toMatchObject({ kind: 'group', botId: null, name: 'Rex, Ana', title: null, members: [rex!.id, ana!.id], speaking: null })
    expect(await transcript(server, chat.id)).toEqual(['You: Morning, team'])
    expect(await chatInfo(server, chat.id)).toMatchObject({ name: 'Rex, Ana', lastMessage: { author: 'owner', text: 'Morning, team' } })
  })

  it('needs at least two bots, all of them existing, and at most six', async () => {
    const { server, bots } = await startWith('Rex', 'Ana', 'Max', 'Kim', 'Lea', 'Tom', 'Zoe')
    const ids = bots.map((bot) => bot.id)

    await expect(server.client.groups.create({ memberIds: [ids[0]!], text: 'Hi' })).rejects.toThrow(/at least 2/)
    await expect(server.client.groups.create({ memberIds: [ids[0]!, ids[0]!], text: 'Hi' })).rejects.toThrow(/at least 2/)
    await expect(server.client.groups.create({ memberIds: ids, text: 'Hi' })).rejects.toThrow(/up to 6/)
    await expect(server.client.groups.create({ memberIds: [ids[0]!, 'nobody'], text: 'Hi' })).rejects.toThrow(/No such bot/)
    expect((await server.client.chats.list()).filter((chat) => chat.kind === 'group')).toEqual([])
  })

  it('keeps the limits the web app checks equal to the server\'s', () => {
    expect([minGroupMembers, maxGroupMembers]).toEqual([groupRoundRules.minMembers, groupRoundRules.maxMembers])
  })

  it('is renamed, named after its members again with a blank name, and follows a member renamed', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())
    const chat = await createGroup(server, [rex!, ana!], 'Hi')

    expect(await server.client.groups.update({ chatId: chat.id, title: '  Launch  ' })).toMatchObject({ name: 'Launch', title: 'Launch' })
    expect(await server.client.groups.update({ chatId: chat.id, title: ' ' })).toMatchObject({ name: 'Rex, Ana', title: null })
    await server.client.bots.update({ botId: ana!.id, name: 'Anna' })
    expect(await chatInfo(server, chat.id)).toMatchObject({ name: 'Rex, Anna' })
  })

  it('adds and removes members, and loses a deleted bot', async () => {
    const { server, bots: [rex, ana, max] } = await startWith('Rex', 'Ana', 'Max')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())
    const chat = await createGroup(server, [rex!, ana!], 'Hi')

    expect(await server.client.groups.update({ chatId: chat.id, memberIds: [rex!.id, ana!.id, max!.id] })).toMatchObject({
      members: [rex!.id, ana!.id, max!.id],
      name: 'Rex, Ana, Max',
    })
    expect(await server.client.groups.update({ chatId: chat.id, memberIds: [rex!.id, max!.id] })).toMatchObject({ name: 'Rex, Max' })
    await expect(server.client.groups.update({ chatId: chat.id, memberIds: [rex!.id] })).rejects.toThrow(/at least 2/)
    await expect(server.client.groups.update({ chatId: rex!.chatId, title: 'DM' })).rejects.toThrow(/No such group chat/)

    await server.client.bots.delete({ botId: max!.id })
    expect(await chatInfo(server, chat.id)).toMatchObject({ members: [rex!.id], name: 'Rex' })
  })
})

describe('rounds', () => {
  it('lets every member answer in turn, each reading what was said since its last turn, and ends when all pass', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...posts('Build is green.'), ...passes())
    server.providers.scriptFor('Ana', ...posts('Docs are ready.'))

    const chat = await createGroup(server, [rex!, ana!], 'Can we ship today?')

    expect(await transcript(server, chat.id)).toEqual(['You: Can we ship today?', 'Rex: Build is green.', 'Ana: Docs are ready.'])
    // Round 1: Rex, Ana. Round 2 would start with Ana, who has heard nothing new; Rex passes, which ends it.
    expect(speakers(server)).toEqual(['Rex', 'Rex', 'Ana', 'Ana', 'Rex'])
    const [rexFirst, , rexSecond] = requestsOf(server, 'Rex')
    expect(lastMessage(rexFirst!)).toContain('[Group chat: \\"Rex, Ana\\" - with Ana]')
    expect(lastMessage(rexFirst!)).toContain('The owner: Can we ship today?')
    // Its second turn shows only what came after its first.
    expect(lastMessage(rexSecond!)).toContain('Ana: Docs are ready.')
    expect(lastMessage(rexSecond!)).not.toContain('Can we ship today?')
    const [anaFirst] = requestsOf(server, 'Ana')
    expect(lastMessage(anaFirst!)).toContain('The owner: Can we ship today?')
    expect(lastMessage(anaFirst!)).toContain('Rex: Build is green.')
    // A pass needs no reply: no reminder followed.
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('plays at most 3 rounds, rotating the order each round', async () => {
    const { server, bots } = await startWith('Rex', 'Ana', 'Max')
    for (const name of ['Rex', 'Ana', 'Max']) {
      server.providers.scriptFor(name, ...posts(`${name} 1`), ...posts(`${name} 2`), ...posts(`${name} 3`))
    }

    const chat = await createGroup(server, bots, 'Brainstorm names')

    expect(speakers(server).filter((_, index) => index % 2 === 0)).toEqual(['Rex', 'Ana', 'Max', 'Ana', 'Max', 'Rex', 'Max', 'Rex', 'Ana'])
    expect(await transcript(server, chat.id)).toHaveLength(1 + 9)
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('plays at most 10 member turns', async () => {
    const { server, bots } = await startWith('Rex', 'Ana', 'Max', 'Kim')
    for (const name of ['Rex', 'Ana', 'Max', 'Kim']) server.providers.scriptFor(name, ...posts(`${name} 1`), ...posts(`${name} 2`))
    // Round 3 would start with Max, then Kim: the 9th and 10th turns.
    server.providers.scriptFor('Max', ...posts('Max 3'))
    server.providers.scriptFor('Kim', ...posts('Kim 3'))

    const chat = await createGroup(server, bots, 'Brainstorm names')

    expect(await transcript(server, chat.id)).toHaveLength(1 + 10)
    expect((await transcript(server, chat.id)).slice(-2)).toEqual(['Max: Max 3', 'Kim: Kim 3'])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('lets only the members mentioned answer, and those they hand over to', async () => {
    const { server, bots: [rex, ana, max] } = await startWith('Rex', 'Ana', 'Max')
    server.providers.scriptFor('Ana', ...posts('@Rex can you check the build?'), ...passes())
    server.providers.scriptFor('Rex', ...posts('Green.'))

    const chat = await createGroup(server, [rex!, ana!, max!], '@ana is the release ready?')

    expect(await transcript(server, chat.id)).toEqual(['You: @ana is the release ready?', 'Ana: @Rex can you check the build?', 'Rex: Green.'])
    expect(requestsOf(server, 'Max')).toEqual([])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('lets every member answer @everyone, even with others mentioned', async () => {
    const { server, bots: [rex, ana, max] } = await startWith('Rex', 'Ana', 'Max')
    for (const name of ['Rex', 'Ana']) server.providers.scriptFor(name, ...posts(`${name} here`), ...passes())
    server.providers.scriptFor('Max', ...posts('Max here'))

    const chat = await createGroup(server, [rex!, ana!, max!], '@everyone roll call, @Rex first')

    expect(await transcript(server, chat.id)).toEqual(['You: @everyone roll call, @Rex first', 'Rex: Rex here', 'Ana: Ana here', 'Max: Max here'])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('posts nothing for a pass, and at most 2 messages in one turn', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor(
      'Rex',
      callsTools(['sendMessage', { text: 'One' }], ['sendMessage', { text: 'Two' }], ['sendMessage', { text: 'Three' }]),
      endsSilently(),
    )
    server.providers.scriptFor('Ana', callsTools(['sendMessage', { text: '(pass)' }]), endsSilently())

    const chat = await createGroup(server, [rex!, ana!], 'Status?')

    // The calls run at once: any two of them are posted.
    expect((await transcript(server, chat.id)).slice(1)).toHaveLength(2)
    expect(JSON.stringify(requestsOf(server, 'Rex')[1]!.messages.slice(-3))).toContain('at most 2 messages in one turn')
    expect(lastMessage(requestsOf(server, 'Ana')[1]!)).toContain('Passed')
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('shows a member at most the 24 newest messages since its last turn', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())
    const chat = await createGroup(server, [rex!, ana!], 'Hi')
    for (let n = 1; n <= 30; n++) {
      await server.db.insert(messages).values({ chatId: chat.id, author: 'bot', authorBotId: ana!.id, authorName: 'Ana', text: `Note ${n}` })
    }
    server.providers.scriptFor('Rex', ...passes())

    await say(server, chat.id, '@Rex summarise')

    const turn = lastMessage(requestsOf(server, 'Rex')[1]!)
    expect(turn).toContain('(7 earlier messages not shown)')
    expect(turn).not.toContain('Note 7\\n')
    expect(turn).toContain('Ana: Note 8')
    expect(turn).toContain('The owner: @Rex summarise')
  })

  it('shows who is taking a turn', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const thinking = held(endsSilently())
    server.providers.scriptFor('Rex', thinking)
    server.providers.scriptFor('Ana', ...passes())

    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Hi' })
    await thinking.requested
    expect(await chatInfo(server, chat.id)).toMatchObject({ speaking: rex!.id })
    thinking.release()
    await server.rounds.idle(chat.id)
    expect(await chatInfo(server, chat.id)).toMatchObject({ speaking: null })
  })

  it("doesn't post for a member removed while its turn waits", async () => {
    const { server, bots: [rex, ana, max] } = await startWith('Rex', 'Ana', 'Max')
    const turn = held(callsTools(['sendMessage', { text: 'Still here?' }]))
    server.providers.scriptFor('Rex', turn, endsSilently())
    server.providers.scriptFor('Ana', ...passes())
    server.providers.scriptFor('Max', ...passes())

    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id, max!.id], text: 'Hi' })
    await turn.requested
    await server.client.groups.update({ chatId: chat.id, memberIds: [ana!.id, max!.id] })
    turn.release()
    await server.rounds.idle(chat.id)

    expect(await transcript(server, chat.id)).toEqual(['You: Hi'])
    expect(JSON.stringify(requestsOf(server, 'Rex')[1]!.messages.at(-1))).toContain('no longer in this group chat')
  })
})

describe("the owner's files in a group chat", () => {
  it('are saved in the group\'s shared folder, and every member\'s turn lists where', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())
    const chat = await createGroup(server, [rex!, ana!], 'Hi')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())

    const sent = await server.client.chats.send({ chatId: chat.id, text: 'Plan attached', files: [textFile('plan.md', '# Ship Friday\n')] })
    await server.rounds.idle(chat.id)

    const folder = join(server.home, 'shared', 'groups', chat.id)
    expect(sent.attachments).toMatchObject([{ name: 'plan.md', mimeType: 'text/plain', size: 14, path: join(folder, 'plan.md') }])
    expect(await readFile(join(folder, 'plan.md'), 'utf8')).toBe('# Ship Friday\n')
    for (const name of ['Rex', 'Ana']) {
      const turn = lastMessage(requestsOf(server, name)[1]!)
      expect(turn).toContain('The owner: Plan attached')
      expect(turn).toContain(`${join(folder, 'plan.md')} (text/plain)`)
    }
    // The owner downloads the copy kept on the server, as in a DM.
    const download = await server.fetch(`/api/messages/${sent.id}/attachments/${sent.attachments[0]!.id}`)
    expect(await download.text()).toBe('# Ship Friday\n')
  })

  it('never overwrite an earlier file of the same name, nor leave the folder', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes(), ...passes())
    server.providers.scriptFor('Ana', ...passes(), ...passes())
    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Hi' })
    await server.rounds.idle(chat.id)

    const sent = await server.client.chats.send({
      chatId: chat.id,
      text: '',
      files: [textFile('notes.txt', 'one'), textFile('../../notes.txt', 'two')],
    })
    await server.rounds.idle(chat.id)

    const folder = join(server.home, 'shared', 'groups', chat.id)
    expect(sent.attachments.map((file) => file.path)).toEqual([join(folder, 'notes.txt'), join(folder, 'notes-2.txt')])
    expect(await readFile(join(folder, 'notes-2.txt'), 'utf8')).toBe('two')
  })
})

describe('deleting a group chat', () => {
  it('removes it, its messages and its files, and keeps its members and what they said in their histories', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...posts('Build is green.'), ...passes())
    server.providers.scriptFor('Ana', ...passes())
    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Status?' })
    await server.rounds.idle(chat.id)
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())
    await server.client.chats.send({ chatId: chat.id, text: 'Plan', files: [textFile('plan.md', 'x')] })
    await server.rounds.idle(chat.id)

    await server.client.groups.delete({ chatId: chat.id })

    expect((await server.client.chats.list()).map((entry) => entry.id)).not.toContain(chat.id)
    await expect(server.client.chats.messages({ chatId: chat.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await server.db.select().from(messages)).filter((message) => message.chatId === chat.id)).toEqual([])
    expect(existsSync(join(server.dataDir, 'attachments', chat.id))).toBe(false)
    expect(existsSync(join(server.home, 'shared', 'groups', chat.id))).toBe(false)
    expect((await server.client.bots.list()).map((bot) => bot.name)).toEqual(['Rex', 'Ana'])

    // Rex's one history still has its turn (ADR 0001).
    server.providers.scriptFor('Rex', ...posts('I said the build is green.'))
    await server.client.chats.send({ chatId: rex!.chatId, text: 'What did you say in the group?' })
    await expect.poll(async () => (await transcript(server, rex!.chatId)).length).toBe(2)
    expect(JSON.stringify(requestsOf(server, 'Rex').at(-2)!.messages)).toContain('Build is green.')
  })

  it('ends the rounds going on and the turn in progress, posting nothing more', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const turn = held(callsTools(['sendMessage', { text: 'Still here?' }]))
    server.providers.scriptFor('Rex', turn, endsSilently())
    server.providers.scriptFor('Ana', ...posts('Me too.'))

    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Hi' })
    await turn.requested
    await server.client.groups.delete({ chatId: chat.id })
    turn.release()

    await server.rounds.idle(chat.id)
    await expect.poll(async () => (await server.client.bots.list()).some((bot) => bot.working)).toBe(false)
    expect(requestsOf(server, 'Ana')).toEqual([])
    expect((await server.db.select().from(messages)).filter((message) => message.chatId === chat.id)).toEqual([])
    expect(await chatInfo(server, chat.id)).toBeUndefined()
  })

  it("drops a member's turn waiting behind its DM work", async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const dmWork = held(callsTools(['sendMessage', { text: 'Report done.' }]))
    server.providers.scriptFor('Rex', dmWork, endsSilently())

    await server.client.chats.send({ chatId: rex!.chatId, text: 'Write the report' })
    await dmWork.requested
    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Anyone there?' })
    await server.client.groups.delete({ chatId: chat.id })
    dmWork.release()

    await server.rounds.idle(chat.id)
    await expect.poll(async () => (await server.client.bots.list()).some((bot) => bot.working)).toBe(false)
    expect(await transcript(server, rex!.chatId)).toEqual(['You: Write the report', 'Rex: Report done.'])
    // Rex's two requests were its DM work; its group turn never ran.
    expect(requestsOf(server, 'Rex')).toHaveLength(2)
    expect(requestsOf(server, 'Ana')).toEqual([])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('ends the rounds at a restart: the turn in progress finishes, nobody else takes one', async () => {
    const { server: before, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const turn = held(callsTools(['sendMessage', { text: 'Still here?' }]))
    before.providers.scriptFor('Rex', turn)
    const { chat } = await before.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Hi' })
    await turn.requested
    expect((await chatInfo(before, chat.id)).speaking).toBe(rex!.id)

    const after = await restartTestServer(before, {
      script: (providers) => providers.scriptFor('Rex', ...posts('Still here.')),
    })
    servers.splice(servers.indexOf(before), 1, after)
    await expect.poll(async () => (await transcript(after, chat.id)).length).toBe(2)
    await expect.poll(async () => (await after.client.bots.list()).some((bot) => bot.working)).toBe(false)

    expect(await transcript(after, chat.id)).toEqual(['You: Hi', 'Rex: Still here.'])
    expect((await chatInfo(after, chat.id)).speaking).toBeNull()
    expect(requestsOf(after, 'Ana')).toEqual([])
    expect(after.providers.pendingTurns).toBe(0)
  })

  it("drops a member's turn waiting behind its DM work at a restart", async () => {
    const { server: before, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const dmWork = held(callsTools(['sendMessage', { text: 'Report done.' }]))
    before.providers.scriptFor('Rex', dmWork)
    await before.client.chats.send({ chatId: rex!.chatId, text: 'Write the report' })
    await dmWork.requested
    const { chat } = await before.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Anyone there?' })

    const after = await restartTestServer(before, {
      script: (providers) => providers.scriptFor('Rex', ...posts('Report done.')),
    })
    servers.splice(servers.indexOf(before), 1, after)
    await expect.poll(async () => (await transcript(after, rex!.chatId)).length).toBe(2)
    await expect.poll(async () => (await after.client.bots.list()).some((bot) => bot.working)).toBe(false)

    expect(await transcript(after, chat.id)).toEqual(['You: Anyone there?'])
    expect((await chatInfo(after, chat.id)).speaking).toBeNull()
    expect(after.providers.pendingTurns).toBe(0)
  })

  it('deletes only group chats', async () => {
    const { server, bots: [rex] } = await startWith('Rex')

    await expect(server.client.groups.delete({ chatId: rex!.chatId })).rejects.toThrow(/No such group chat/)
    await expect(server.client.groups.delete({ chatId: 'nothing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await server.client.bots.list()).toHaveLength(1)
  })
})

describe('a member’s one history', () => {
  it('keeps its group turn apart from its DM: neither steers the other', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const dmWork = held(callsTools(['sendMessage', { text: 'Report done.' }]))
    server.providers.scriptFor('Rex', dmWork, endsSilently(), ...posts('Here now.'))
    server.providers.scriptFor('Ana', ...passes())

    await server.client.chats.send({ chatId: rex!.chatId, text: 'Write the report' })
    await dmWork.requested
    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Anyone there?' })
    dmWork.release()
    await server.rounds.idle(chat.id)

    expect(await transcript(server, rex!.chatId)).toEqual(['You: Write the report', 'Rex: Report done.'])
    expect(await transcript(server, chat.id)).toEqual(['You: Anyone there?', 'Rex: Here now.'])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it("is interrupted in its group turn by the owner's DM message; the turn is retried after it, and the rounds go on", async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    const groupTurn = held(callsTools(['sendMessage', { text: 'On it.' }]))
    server.providers.scriptFor('Rex', groupTurn, ...posts('Lunch at noon.'), ...posts("I'll take the release."), ...passes())
    server.providers.scriptFor('Ana', ...posts('Thanks, Rex.'))

    const { chat } = await server.client.groups.create({ memberIds: [rex!.id, ana!.id], text: 'Who takes the release?' })
    await groupTurn.requested
    await server.client.chats.send({ chatId: rex!.chatId, text: 'When is lunch?' })
    await server.rounds.idle(chat.id)
    groupTurn.release()

    expect(await transcript(server, rex!.chatId)).toEqual(['You: When is lunch?', 'Rex: Lunch at noon.'])
    expect(await transcript(server, chat.id)).toEqual(['You: Who takes the release?', "Rex: I'll take the release.", 'Ana: Thanks, Rex.'])
    const retried = requestsOf(server, 'Rex')[3]!
    expect(lastMessage(retried)).toContain(interruptedNote)
    expect(lastMessage(retried)).toContain('Who takes the release?')
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('answers in its DM about a group chat from its history', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...posts('The launch moves to Friday.'), ...passes())
    const chat = await createGroup(server, [rex!, ana!], 'Any news on the launch?')
    server.providers.scriptFor('Rex', ...posts('Ana said it moves to Friday.'))

    await server.client.chats.send({ chatId: rex!.chatId, text: 'What did Ana say about the launch?' })
    await expect.poll(async () => (await transcript(server, rex!.chatId)).length).toBe(2)

    const dmRequest = JSON.stringify(requestsOf(server, 'Rex').at(-2)!.messages)
    expect(dmRequest).toContain('Ana: The launch moves to Friday.')
    expect(dmRequest).toContain('What did Ana say about the launch?')
    expect(await transcript(server, chat.id)).toEqual(['You: Any news on the launch?', 'Ana: The launch moves to Friday.'])
  })

  it('lists its group chats in its prompt, with the rule never to reveal its DM', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())
    const chat = await createGroup(server, [rex!, ana!], 'Hi')
    await server.client.groups.update({ chatId: chat.id, title: 'Launch' })
    server.providers.scriptFor('Rex', ...posts('Hi'))

    await server.client.chats.send({ chatId: rex!.chatId, text: 'Hello' })
    await expect.poll(async () => (await transcript(server, rex!.chatId)).length).toBe(2)

    const prompt = JSON.stringify(requestsOf(server, 'Rex').at(-1)!.messages)
    expect(prompt).toContain('- \\"Launch\\", with Ana')
    expect(prompt).toMatch(/Never reveal what the owner told you privately/)
  })
})

describe('a bot posting to a group chat', () => {
  it('posts to a group it belongs to, and the other members answer', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())
    const chat = await createGroup(server, [rex!, ana!], 'Hi')
    await server.client.groups.update({ chatId: chat.id, title: 'Launch' })
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: '#launch', text: 'Standup: the build is green.' }]),
      callsTools(['sendMessage', { text: 'Posted the standup.' }]),
      endsSilently(),
    )
    server.providers.scriptFor('Ana', ...posts('Thanks, docs are next.'))
    server.providers.scriptFor('Rex', ...passes())

    await server.client.chats.send({ chatId: rex!.chatId, text: 'Post the standup in Launch' })
    await expect.poll(async () => (await transcript(server, chat.id)).length).toBe(3)
    await server.rounds.idle(chat.id)
    await expect.poll(async () => (await server.client.bots.list()).some((bot) => bot.working)).toBe(false)

    // Ana answers; Rex, who posted, gets a turn only in round 2, for Ana's answer, and passes.
    expect(await transcript(server, chat.id)).toEqual(['You: Hi', 'Rex: Standup: the build is green.', 'Ana: Thanks, docs are next.'])
    expect(await transcript(server, rex!.chatId)).toEqual(['You: Post the standup in Launch', 'Rex: Posted the standup.'])
    expect(server.providers.pendingTurns).toBe(0)
  })

  it('posts text only, dropping images with a note', async () => {
    const { server, bots: [rex, ana] } = await startWith('Rex', 'Ana')
    server.providers.scriptFor('Rex', ...passes())
    server.providers.scriptFor('Ana', ...passes())
    const chat = await createGroup(server, [rex!, ana!], 'Hi')
    await server.client.groups.update({ chatId: chat.id, title: 'Launch' })
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: 'Launch', text: 'The new logo', images: ['logo.png'] }]),
      callsTools(['sendMessage', { text: 'Posted it.' }]),
      endsSilently(),
    )
    server.providers.scriptFor('Ana', ...passes())

    await server.client.chats.send({ chatId: rex!.chatId, text: 'Show Launch the logo' })
    await expect.poll(async () => (await transcript(server, chat.id)).length).toBe(2)
    await server.rounds.idle(chat.id)
    await expect.poll(async () => (await server.client.bots.list()).some((bot) => bot.working)).toBe(false)

    const [, posted] = await server.client.chats.messages({ chatId: chat.id })
    expect(posted).toMatchObject({ text: 'The new logo', attachments: [] })
    expect(JSON.stringify(requestsOf(server, 'Rex').at(-2)!.messages.at(-1))).toContain(
      'Note: the image was NOT delivered: group posts are text only; send images to a teammate directly.',
    )
  })

  it("can't post to a group it isn't in", async () => {
    const { server, bots: [rex, ana, max] } = await startWith('Rex', 'Ana', 'Max')
    server.providers.scriptFor('Ana', ...passes())
    server.providers.scriptFor('Max', ...passes())
    const chat = await createGroup(server, [ana!, max!], 'Hi')
    await server.client.groups.update({ chatId: chat.id, title: 'Design' })
    server.providers.scriptFor(
      'Rex',
      callsTools(['message_bot', { to: 'Design', text: 'Can I join?' }]),
      callsTools(['sendMessage', { text: "I'm not in Design." }]),
      endsSilently(),
    )

    await server.client.chats.send({ chatId: rex!.chatId, text: 'Ask Design' })
    await expect.poll(async () => (await transcript(server, rex!.chatId)).length).toBe(2)

    expect(JSON.stringify(requestsOf(server, 'Rex')[1]!.messages.at(-1))).toContain(`You aren't in the group chat \\"Design\\"`)
    expect(await transcript(server, chat.id)).toEqual(['You: Hi'])
    expect(server.providers.pendingTurns).toBe(0)
  })
})
