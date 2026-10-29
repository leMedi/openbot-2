import { type ChatInfo, type LiveEvent, maxSectionNameLength, type NewBot } from '@openbot/api-contract'
import { maxSectionNameLength as serverMaxSectionNameLength } from '@openbot/core'
import { chats } from '@openbot/db'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, restartTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = {
  name: 'Rex',
  title: 'Builder',
  instructions: '',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
}

async function start() {
  const server = await createTestServer()
  servers.push(server)
  return server
}

const unassigned = { id: 'unassigned', name: null }

describe('sections', () => {
  it('start with Unassigned alone, and a new section goes to the top', async () => {
    const server = await start()
    expect(await server.client.sections.list()).toEqual([unassigned])

    const work = await server.client.sections.create({ name: ' Work ' })
    const home = await server.client.sections.create({ name: 'Home' })

    expect(work).toMatchObject({ name: 'Work' })
    expect(await server.client.sections.list()).toEqual([home, work, unassigned])
  })
})

/** A server with three bots, by name. */
async function threeBots() {
  const server = await start()
  const [rexBot, ana, max] = [
    await server.client.bots.create(rex),
    await server.client.bots.create({ ...rex, name: 'Ana' }),
    await server.client.bots.create({ ...rex, name: 'Max' }),
  ]
  return { server, rex: rexBot, ana, max }
}

/** Each chat's section and whether it is hidden or pinned, by chat id. */
const placesOf = (chats: ChatInfo[]) =>
  Object.fromEntries(chats.map((chat) => [chat.id, { section: chat.sectionId, hidden: chat.hidden, pinned: chat.pinnedPosition }]))

const places = async (server: TestServer) => placesOf(await server.client.chats.list())

describe('section changes', () => {
  it("keeps the name limit the web app checks equal to the server's", () => {
    expect(maxSectionNameLength).toBe(serverMaxSectionNameLength)
  })


  it('rename a section, refusing a blank or long name and Unassigned', async () => {
    const server = await start()
    const work = await server.client.sections.create({ name: 'Work' })

    expect(await server.client.sections.rename({ sectionId: work.id, name: 'Clients' })).toEqual({ id: work.id, name: 'Clients' })
    await expect(server.client.sections.rename({ sectionId: work.id, name: '  ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(server.client.sections.rename({ sectionId: work.id, name: 'x'.repeat(41) })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(server.client.sections.rename({ sectionId: 'unassigned', name: 'Misc' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(server.client.sections.rename({ sectionId: 'nope', name: 'Misc' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.sections.create({ name: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('reorder every section, Unassigned included, and keep the order across a restart', async () => {
    const server = await start()
    const work = await server.client.sections.create({ name: 'Work' })
    const home = await server.client.sections.create({ name: 'Home' })

    expect(await server.client.sections.reorder({ sectionIds: ['unassigned', work.id, home.id] })).toEqual([unassigned, work, home])
    await expect(server.client.sections.reorder({ sectionIds: ['unassigned', work.id] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    const restarted = await restartTestServer(server)
    servers.push(restarted)
    expect(await restarted.client.sections.list()).toEqual([unassigned, work, home])
  })

  it('move chats to a section and back to Unassigned', async () => {
    const { server, rex, ana, max } = await threeBots()
    const work = await server.client.sections.create({ name: 'Work' })

    const chats = await server.client.chats.move({ chatIds: [rex.chatId, ana.chatId], sectionId: work.id })

    expect(placesOf(chats)).toEqual({
      [rex.chatId]: { section: work.id, hidden: false, pinned: null },
      [ana.chatId]: { section: work.id, hidden: false, pinned: null },
      [max.chatId]: { section: 'unassigned', hidden: false, pinned: null },
    })
    await server.client.chats.move({ chatIds: [ana.chatId], sectionId: 'unassigned' })
    expect((await places(server))[ana.chatId]!.section).toBe('unassigned')
    await expect(server.client.chats.move({ chatIds: [rex.chatId], sectionId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.chats.move({ chatIds: ['nope'], sectionId: work.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('delete a section, moving its chats to Unassigned, but never Unassigned', async () => {
    const { server, rex } = await threeBots()
    const work = await server.client.sections.create({ name: 'Work' })
    const home = await server.client.sections.create({ name: 'Home' })
    await server.client.chats.move({ chatIds: [rex.chatId], sectionId: work.id })

    await server.client.sections.delete({ sectionId: work.id })

    expect(await server.client.sections.list()).toEqual([home, unassigned])
    expect((await places(server))[rex.chatId]!.section).toBe('unassigned')
    await expect(server.client.sections.delete({ sectionId: 'unassigned' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('hidden chats', () => {
  it('hiding unpins a chat, the others keeping their order, and keeps its section', async () => {
    const { server, rex, ana, max } = await threeBots()
    const work = await server.client.sections.create({ name: 'Work' })
    await server.client.chats.move({ chatIds: [ana.chatId], sectionId: work.id })
    await server.client.chats.setPinned({ chatIds: [rex.chatId, ana.chatId, max.chatId] })

    const chats = await server.client.chats.hide({ chatIds: [ana.chatId] })

    expect(placesOf(chats)).toEqual({
      [rex.chatId]: { section: 'unassigned', hidden: false, pinned: 0 },
      [ana.chatId]: { section: work.id, hidden: true, pinned: null },
      [max.chatId]: { section: 'unassigned', hidden: false, pinned: 1 },
    })
  })

  it('showing puts a chat back in its section, or in Unassigned once that is deleted', async () => {
    const { server, rex, ana } = await threeBots()
    const work = await server.client.sections.create({ name: 'Work' })
    const home = await server.client.sections.create({ name: 'Home' })
    await server.client.chats.move({ chatIds: [rex.chatId], sectionId: work.id })
    await server.client.chats.move({ chatIds: [ana.chatId], sectionId: home.id })
    await server.client.chats.hide({ chatIds: [rex.chatId, ana.chatId] })
    await server.client.sections.delete({ sectionId: home.id })

    const chats = await server.client.chats.show({ chatIds: [rex.chatId, ana.chatId] })

    expect(placesOf(chats)[rex.chatId]).toEqual({ section: work.id, hidden: false, pinned: null })
    expect(placesOf(chats)[ana.chatId]).toEqual({ section: 'unassigned', hidden: false, pinned: null })
  })

  it('moving a hidden chat to a section shows it there', async () => {
    const { server, rex } = await threeBots()
    const work = await server.client.sections.create({ name: 'Work' })
    await server.client.chats.hide({ chatIds: [rex.chatId] })

    await server.client.chats.move({ chatIds: [rex.chatId], sectionId: work.id })

    expect((await places(server))[rex.chatId]).toEqual({ section: work.id, hidden: false, pinned: null })
  })

  it('stay hidden across a restart, and refuse chats that do not exist', async () => {
    const { server, rex } = await threeBots()
    await server.client.chats.hide({ chatIds: [rex.chatId] })
    await expect(server.client.chats.hide({ chatIds: ['nope'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const restarted = await restartTestServer(server)
    servers.push(restarted)
    expect((await places(restarted))[rex.chatId]!.hidden).toBe(true)
  })

  it('a deleted group chat leaves its section', async () => {
    const { server, rex, ana } = await threeBots()
    const work = await server.client.sections.create({ name: 'Work' })
    // Made without its first message, which would wake the members.
    const [group] = await server.db.insert(chats).values({ kind: 'group', members: [rex.id, ana.id] }).returning()
    await server.client.chats.move({ chatIds: [group!.id], sectionId: work.id })

    await server.client.groups.delete({ chatId: group!.id })

    expect((await places(server))[group!.id]).toBeUndefined()
    await server.client.sections.delete({ sectionId: work.id })
    expect(await server.client.sections.list()).toEqual([unassigned])
  })

  it('a deleted bot leaves its section', async () => {
    const { server, rex } = await threeBots()
    const work = await server.client.sections.create({ name: 'Work' })
    await server.client.chats.move({ chatIds: [rex.chatId], sectionId: work.id })

    await server.client.bots.delete({ botId: rex.id })
    await server.client.sections.delete({ sectionId: work.id })

    expect(await server.client.sections.list()).toEqual([unassigned])
  })
})

describe('live sections', () => {
  it('tell every tab when sections change and chats move or hide', async () => {
    const { server, rex } = await threeBots()
    const controller = new AbortController()
    const stream = await server.client.events(undefined, { signal: controller.signal })
    await stream.next() // hello

    const work = await server.client.sections.create({ name: 'Work' })
    await server.client.chats.move({ chatIds: [rex.chatId], sectionId: work.id })
    await server.client.chats.hide({ chatIds: [rex.chatId] })
    await server.client.sections.delete({ sectionId: work.id })

    const seen: string[] = []
    for (;;) {
      const { done, value } = await stream.next()
      if (done) throw new Error('The event stream ended')
      const event: LiveEvent = value.event
      if (event.type === 'sections.updated') seen.push(`sections: ${event.sections.map((section) => section.name ?? 'Unassigned').join(', ')}`)
      if (event.type === 'chat.updated') seen.push(`chat: ${event.chat.sectionId === work.id ? 'Work' : event.chat.sectionId}${event.chat.hidden ? ', hidden' : ''}`)
      if (seen.length === 5) break
    }
    controller.abort()
    expect(seen).toEqual(['sections: Work, Unassigned', 'chat: Work', 'chat: Work, hidden', 'sections: Unassigned', 'chat: unassigned, hidden'])
  })
})
