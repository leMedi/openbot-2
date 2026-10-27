import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callsTools, endsSilently } from '@openbot/agent/testing'
import { type BotInfo, maxAttachmentBytes, maxAttachments, type NewBot } from '@openbot/api-contract'
import * as core from '@openbot/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const rex: NewBot = {
  name: 'Rex',
  title: null,
  instructions: '',
  avatarShape: 'hex',
  avatarColor: 'blue',
  model: null,
}

async function startWithRex() {
  const server = await createTestServer()
  servers.push(server)
  await server.connectProvider()
  await server.client.models.updateSettings({ defaultModel: 'fake/fake-model' })
  const bot = await server.client.bots.create(rex)
  return { server, bot }
}

async function untilIdle(server: TestServer, bot: BotInfo) {
  await expect.poll(async () => (await server.client.bots.list()).find((entry) => entry.id === bot.id)?.working).toBe(false)
}

/** A 1×1 PNG. */
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)

const textFile = (name: string, content: string) => new File([content], name, { type: 'text/plain' })

describe('attachments from the owner', () => {
  it("are saved to the bot's uploads folder and listed in the owner's message", async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['sendMessage', { text: 'Got it' }]), endsSilently())

    const sent = await server.client.chats.send({
      chatId: bot.chatId,
      text: 'Have a look',
      files: [textFile('notes.txt', 'Ship on Friday\n'), new File([pixel], 'screen.png', { type: 'image/png' })],
    })
    await untilIdle(server, bot)

    const uploads = join(server.home, 'bots', bot.id, 'uploads')
    expect(sent.attachments.map(({ name, mimeType, size, path }) => ({ name, mimeType, size, path }))).toEqual([
      { name: 'notes.txt', mimeType: 'text/plain', size: 15, path: join(uploads, 'notes.txt') },
      { name: 'screen.png', mimeType: 'image/png', size: pixel.length, path: join(uploads, 'screen.png') },
    ])
    expect(await readFile(join(uploads, 'notes.txt'), 'utf8')).toBe('Ship on Friday\n')
    expect(await readFile(join(uploads, 'screen.png'))).toEqual(pixel)
    expect((await server.client.chats.messages({ chatId: bot.chatId }))[0]!.attachments).toEqual(sent.attachments)
  })

  it('never overwrite an earlier upload of the same name', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(endsSilently(), endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: '', files: [textFile('notes.txt', 'one')] })
    await untilIdle(server, bot)
    const second = await server.client.chats.send({ chatId: bot.chatId, text: '', files: [textFile('notes.txt', 'two')] })
    await untilIdle(server, bot)

    const uploads = join(server.home, 'bots', bot.id, 'uploads')
    expect(second.attachments[0]!.path).toBe(join(uploads, 'notes-2.txt'))
    expect(await readFile(join(uploads, 'notes.txt'), 'utf8')).toBe('one')
    expect(await readFile(join(uploads, 'notes-2.txt'), 'utf8')).toBe('two')
  })

  it('keep a file name from leaving the uploads folder', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(endsSilently())

    const sent = await server.client.chats.send({ chatId: bot.chatId, text: '', files: [textFile('../../evil.sh', 'rm -rf /')] })
    await untilIdle(server, bot)

    expect(sent.attachments[0]!.path).toBe(join(server.home, 'bots', bot.id, 'uploads', 'evil.sh'))
  })

  it('need a text or a file, and at most 6 files', async () => {
    const { server, bot } = await startWithRex()

    await expect(server.client.chats.send({ chatId: bot.chatId, text: '  ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const seven = Array.from({ length: 7 }, (_, index) => textFile(`${index}.txt`, 'x'))
    await expect(server.client.chats.send({ chatId: bot.chatId, text: 'hi', files: seven })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(await server.client.chats.messages({ chatId: bot.chatId })).toEqual([])
  })

  it('have the same limits in the API as on the server', () => {
    expect([maxAttachments, maxAttachmentBytes]).toEqual([core.maxAttachments, core.maxAttachmentBytes])
  })

  it("are given to the bot's run as paths, and images as image input", async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(callsTools(['sendMessage', { text: 'Nice' }]), endsSilently())

    await server.client.chats.send({
      chatId: bot.chatId,
      text: 'What do you think?',
      files: [textFile('notes.txt', 'hi'), new File([pixel], 'screen.png', { type: 'image/png' })],
    })
    await untilIdle(server, bot)

    const input = server.providers.requests[0]!.messages.at(-1)!
    expect(input.role).toBe('user')
    const content = input.content as Exclude<typeof input.content, string>
    const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    expect(text).toContain('What do you think?')
    expect(text).toContain(join(server.home, 'bots', bot.id, 'uploads', 'notes.txt'))
    expect(text).toContain(join(server.home, 'bots', bot.id, 'uploads', 'screen.png'))
    expect(content).toContainEqual({ type: 'image', mimeType: 'image/png', data: pixel.toString('base64') })
  })

  it('arrive over HTTP as a multipart form', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(endsSilently())
    const form = new FormData()
    form.append('text', 'From the browser')
    form.append('files[0]', textFile('notes.txt', 'Ship on Friday\n'))

    const response = await server.fetch(`/api/chats/${bot.chatId}/messages`, { method: 'POST', body: form })
    await untilIdle(server, bot)

    expect(response.status).toBe(200)
    expect((await response.json()).attachments).toMatchObject([{ name: 'notes.txt', size: 15 }])
    expect(await readFile(join(server.home, 'bots', bot.id, 'uploads', 'notes.txt'), 'utf8')).toBe('Ship on Friday\n')
  })

  it('can be downloaded by the owner', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(endsSilently())
    const sent = await server.client.chats.send({ chatId: bot.chatId, text: '', files: [textFile('notes.txt', 'Ship on Friday\n')] })
    await untilIdle(server, bot)

    const response = await server.fetch(`/api/messages/${sent.id}/attachments/${sent.attachments[0]!.id}`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('Ship on Friday\n')
  })

  it('show in the sidebar preview of an attachment-only message', async () => {
    const { server, bot } = await startWithRex()
    server.providers.script(endsSilently())

    await server.client.chats.send({ chatId: bot.chatId, text: '', files: [new File([pixel], 'screen.png', { type: 'image/png' })] })
    await untilIdle(server, bot)

    const chat = (await server.client.chats.list()).find((entry) => entry.id === bot.chatId)!
    expect(chat.lastMessage).toMatchObject({ text: '', attachments: [{ name: 'screen.png', mimeType: 'image/png' }] })
  })
})

describe('attachments from a bot', () => {
  async function botSends(server: TestServer, bot: BotInfo, ...turns: Parameters<TestServer['providers']['script']>) {
    server.providers.script(...turns, endsSilently())
    await server.client.chats.send({ chatId: bot.chatId, text: 'Send me the report' })
    await untilIdle(server, bot)
    return (await server.client.chats.messages({ chatId: bot.chatId })).filter((message) => message.author === 'bot')
  }

  it('attach a file from the computer that the owner can download, as it was when sent', async () => {
    const { server, bot } = await startWithRex()

    const [message] = await botSends(
      server,
      bot,
      callsTools(['write', { path: 'report.md', content: '# Report\n' }]),
      callsTools(['sendMessage', { text: 'Here it is', attachments: ['report.md'] }]),
    )

    const path = join(server.home, 'bots', bot.id, 'report.md')
    expect(message).toMatchObject({ text: 'Here it is', attachments: [{ name: 'report.md', mimeType: 'text/markdown', size: 9, path }] })
    await writeFile(path, 'Changed later\n')
    const response = await server.fetch(`/api/messages/${message!.id}/attachments/${message!.attachments[0]!.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/markdown')
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="report\.md"/)
    expect(await response.text()).toBe('# Report\n')
  })

  it('send a file without text', async () => {
    const { server, bot } = await startWithRex()
    await mkdir(join(server.home, 'shared'), { recursive: true })
    await writeFile(join(server.home, 'shared', 'pixel.png'), pixel)

    const [message] = await botSends(server, bot, callsTools(['sendMessage', { text: '', attachments: [join(server.home, 'shared', 'pixel.png')] }]))

    expect(message).toMatchObject({ text: '', attachments: [{ name: 'pixel.png', mimeType: 'image/png', size: pixel.length }] })
  })

  it("see the send fail, posting nothing, when a file isn't there", async () => {
    const { server, bot } = await startWithRex()

    const messages = await botSends(
      server,
      bot,
      callsTools(['sendMessage', { text: 'Here it is', attachments: ['missing.md'] }]),
      callsTools(['sendMessage', { text: "I couldn't find it" }]),
    )

    expect(messages.map((message) => message.text)).toEqual(["I couldn't find it"])
    expect(JSON.stringify(server.providers.requests[1]!.messages.at(-1))).toContain('"isError":true')
  })

  it('can no longer be downloaded once their bot is deleted', async () => {
    const { server, bot } = await startWithRex()
    const [message] = await botSends(
      server,
      bot,
      callsTools(['write', { path: 'report.md', content: '# Report\n' }]),
      callsTools(['sendMessage', { text: 'Here', attachments: ['report.md'] }]),
    )

    await server.client.bots.delete({ botId: bot.id })

    const response = await server.fetch(`/api/messages/${message!.id}/attachments/${message!.attachments[0]!.id}`)
    expect(response.status).toBe(404)
  })
})
