import type { NewBot } from '@openbot/api-contract'
import { postMessage } from '@openbot/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = { name: 'Rex', title: 'Builder', instructions: 'Rex fixes builds.', avatarShape: 'hex', avatarColor: 'blue', model: null }

/** Rex's DM with `count` messages from the owner, "1" to `count`, oldest first. */
async function startWithMessages(count: number) {
  const server = await createTestServer()
  servers.push(server)
  const bot = await server.client.bots.create(rex)
  for (let index = 1; index <= count; index++) await post(server, bot.chatId, `${index}`)
  return { server, chatId: bot.chatId }
}

const post = (server: TestServer, chatId: string, text: string) => postMessage(server.db, { chatId, author: 'owner', authorName: 'You', text })

const texts = (page: { messages: { text: string }[] }) => page.messages.map((message) => message.text)

describe("paging a chat's messages", () => {
  it('returns the latest page newest first, then each older page by its cursor, until the first message', async () => {
    const { server, chatId } = await startWithMessages(5)

    const latest = await server.client.chats.messages({ chatId, limit: 2 })
    expect(texts(latest)).toEqual(['5', '4'])
    const middle = await server.client.chats.messages({ chatId, limit: 2, cursor: latest.nextCursor! })
    expect(texts(middle)).toEqual(['3', '2'])
    const first = await server.client.chats.messages({ chatId, limit: 2, cursor: middle.nextCursor! })
    expect(texts(first)).toEqual(['1'])
    expect(first.nextCursor).toBeNull()
  })

  it('keeps older pages the same while new messages arrive', async () => {
    const { server, chatId } = await startWithMessages(4)
    const latest = await server.client.chats.messages({ chatId, limit: 2 })

    await post(server, chatId, '5')
    await post(server, chatId, '6')

    const older = await server.client.chats.messages({ chatId, limit: 2, cursor: latest.nextCursor! })
    expect(texts(older)).toEqual(['2', '1'])
    expect(older.nextCursor).toBeNull()
    expect(texts(await server.client.chats.messages({ chatId, limit: 2 }))).toEqual(['6', '5'])
  })

  it('pages over HTTP as the apps call it, 50 to a page unless asked', async () => {
    const { server, chatId } = await startWithMessages(53)

    const latest = await (await server.fetch(`/api/chats/${chatId}/messages`)).json()
    expect(latest.messages).toHaveLength(50)
    expect(latest.messages[0].text).toBe('53')

    const older = await (await server.fetch(`/api/chats/${chatId}/messages?cursor=${latest.nextCursor}&limit=10`)).json()
    expect(texts(older)).toEqual(['3', '2', '1'])
    expect(older.nextCursor).toBeNull()
  })

  it('returns an empty page for a chat with no messages, and refuses a chat that does not exist', async () => {
    const { server, chatId } = await startWithMessages(0)

    expect(await server.client.chats.messages({ chatId })).toEqual({ messages: [], nextCursor: null })
    await expect(server.client.chats.messages({ chatId: 'nope' })).rejects.toThrow('No such chat')
  })

  it('refuses a page larger than 200', async () => {
    const { server, chatId } = await startWithMessages(0)

    expect((await server.fetch(`/api/chats/${chatId}/messages?limit=201`)).status).toBe(400)
  })
})
