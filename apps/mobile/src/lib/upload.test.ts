import { describe, expect, it } from 'vitest'
import { type FormLike, type RequestLike, sendWithFiles } from './upload.ts'

/** A fake XMLHttpRequest that records what was sent, answered by the test. */
function fakeRequest() {
  const request = {
    opened: undefined as [string, string] | undefined,
    sent: undefined as unknown,
    status: 0,
    responseText: '',
    upload: { onprogress: null as ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null },
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onabort: null as (() => void) | null,
    ontimeout: null as (() => void) | null,
    open(method: string, url: string) {
      request.opened = [method, url]
    },
    setRequestHeader() {},
    send(body: unknown) {
      request.sent = body
    },
    abort() {
      request.onabort?.()
    },
    answer(status: number, body: unknown) {
      request.status = status
      request.responseText = JSON.stringify(body)
      request.onload?.()
    },
  }
  return request
}

function fakeForm(): FormLike & { fields: [string, unknown][] } {
  const fields: [string, unknown][] = []
  return { fields, append: (name: string, value: unknown) => void fields.push([name, value]) }
}

const photo = { uri: 'file:///cache/IMG_1.jpg', name: 'IMG_1.jpg', size: 2048, mimeType: 'image/jpeg' }
const notes = { uri: 'file:///cache/notes.pdf', name: 'notes.pdf', size: 100, mimeType: 'application/pdf' }

function send(options: { onProgress?: (fraction: number) => void; signal?: AbortSignal; replyToId?: string } = {}) {
  const request = fakeRequest()
  const form = fakeForm()
  const sent = sendWithFiles({
    url: 'http://192.168.1.20:3000',
    chatId: 'chat 1',
    text: 'Look',
    files: [photo, notes],
    ...options,
    request: () => request as unknown as RequestLike,
    form: () => form,
  })
  return { request, form, sent }
}

describe('sending a message with files from the phone', () => {
  it("posts a multipart form to the chat's messages, as the API's client would", async () => {
    const { request, form, sent } = send()
    expect(request.opened).toEqual(['POST', 'http://192.168.1.20:3000/api/chats/chat%201/messages'])
    expect(request.sent).toBe(form)
    expect(form.fields).toEqual([
      ['text', 'Look'],
      ['files[0]', { uri: photo.uri, name: 'IMG_1.jpg', type: 'image/jpeg' }],
      ['files[1]', { uri: notes.uri, name: 'notes.pdf', type: 'application/pdf' }],
    ])
    request.answer(200, { id: 'm1', text: 'Look' })
    await expect(sent).resolves.toEqual({ id: 'm1', text: 'Look' })
  })

  it('says which message it replies to', () => {
    const { form } = send({ replyToId: 'm0' })
    expect(form.fields.slice(0, 2)).toEqual([
      ['text', 'Look'],
      ['replyToId', 'm0'],
    ])
  })

  it('reports how much has gone up', () => {
    const progress: number[] = []
    const { request } = send({ onProgress: (fraction) => progress.push(fraction) })
    request.upload.onprogress?.({ loaded: 512, total: 2048, lengthComputable: true })
    request.upload.onprogress?.({ loaded: 0, total: 0, lengthComputable: false })
    expect(progress).toEqual([0.25])
  })

  it("fails with the instance's message when it refuses", async () => {
    const { request, sent } = send()
    request.answer(400, { defined: false, code: 'BAD_REQUEST', status: 400, message: 'Input validation failed' })
    await expect(sent).rejects.toThrow('Input validation failed')
  })

  it('fails with the status when the answer says nothing', async () => {
    const { request, sent } = send()
    request.status = 502
    request.responseText = '<html>Bad gateway</html>'
    request.onload?.()
    await expect(sent).rejects.toThrow("Couldn't send (HTTP 502)")
  })

  it('fails when the instance cannot be reached', async () => {
    const { request, sent } = send()
    request.onerror?.()
    await expect(sent).rejects.toThrow("Couldn't reach OpenBot")
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const { sent } = send({ signal: controller.signal })
    controller.abort()
    await expect(sent).rejects.toThrow('Cancelled')
  })
})
