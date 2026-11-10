import type { MessageInfo } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { addFiles, attachmentKind, formatSize, transcript } from './chat.ts'

const mb = 1024 * 1024
const file = (name: string, size = 10) => ({ name, size })

describe('adding files to the composer', () => {
  it('adds them after those already there', () => {
    expect(addFiles([file('a.txt')], [file('b.png')])).toEqual({ files: [file('a.txt'), file('b.png')] })
  })

  it('keeps 6 at most, saying so', () => {
    const five = ['1', '2', '3', '4', '5'].map((name) => file(name))
    expect(addFiles(five, [file('6'), file('7')])).toEqual({ files: [...five, file('6')], notice: 'You can attach up to 6 files' })
  })

  it('leaves out a file over 50 MB, naming it', () => {
    expect(addFiles([], [file('big.mov', 51 * mb), file('small.png')])).toEqual({ files: [file('small.png')], notice: 'big.mov is larger than 50 MB' })
  })
})

describe('file sizes for people', () => {
  it('reads bytes, kilobytes and megabytes', () => {
    expect([formatSize(512), formatSize(12 * 1024), formatSize(3.4 * mb)]).toEqual(['512 B', '12 KB', '3.4 MB'])
  })
})

describe('how an attachment shows', () => {
  it('shows images and videos as media, audio as audio, the rest as files', () => {
    expect(['image/png', 'image/svg+xml', 'video/mp4', 'audio/mpeg', 'application/pdf'].map((mimeType) => attachmentKind({ mimeType }))).toEqual([
      'image',
      'file',
      'video',
      'audio',
      'file',
    ])
  })
})

let next = 0
function message(fields: Partial<MessageInfo> & Pick<MessageInfo, 'author'>): MessageInfo {
  next++
  return {
    id: `m${String(next).padStart(3, '0')}`,
    chatId: 'chat',
    botId: fields.author === 'bot' ? 'rex' : null,
    authorName: fields.author === 'bot' ? 'Rex' : 'You',
    text: '',
    attachments: [],
    card: null,
    botMessage: null,
    createdAt: 0,
    ...fields,
  } as MessageInfo
}

describe("a chat's transcript", () => {
  it('lists the messages, then what the owner sent that the server has not returned yet', () => {
    const hello = message({ author: 'owner', text: 'Hello' })
    const reply = message({ author: 'bot', text: 'Hi' })
    const rows = transcript([hello, reply], [{ key: 'k1', text: 'Still there?', files: [], after: reply.id }])
    expect(rows.map((row) => [row.key, row.mine, row.text])).toEqual([
      [hello.id, true, 'Hello'],
      [reply.id, false, 'Hi'],
      ['k1', true, 'Still there?'],
    ])
    expect(rows[2]!.outgoing?.key).toBe('k1')
  })

  it("drops a sent message once the server's copy is in, even before the send returns", () => {
    const before = message({ author: 'bot', text: 'Ask me' })
    const copy = message({ author: 'owner', text: 'Done', attachments: [{ id: 'a', name: 'x.png', mimeType: 'image/png', size: 7, path: '/x.png' }] })
    const rows = transcript([before, copy], [{ key: 'k', text: 'Done', files: [file('x.png', 7)], after: before.id }])
    expect(rows.map((row) => row.key)).toEqual([before.id, copy.id])
  })

  it("keeps a sent message whose text matches only an older one of the owner's", () => {
    const older = message({ author: 'owner', text: 'ok' })
    const rows = transcript([older], [{ key: 'k', text: 'ok', files: [], after: older.id }])
    expect(rows.map((row) => row.key)).toEqual([older.id, 'k'])
  })

  it("groups each author's consecutive messages", () => {
    const rows = transcript([message({ author: 'bot' }), message({ author: 'bot' }), message({ author: 'owner' })], [{ key: 'k', text: 'x', files: [], after: undefined }])
    expect(rows.map((row) => [row.continuesPrevious, row.continuesNext])).toEqual([
      [false, true],
      [true, false],
      [false, true],
      [true, false],
    ])
  })

  it('tells bots apart in a group', () => {
    const rows = transcript([message({ author: 'bot', botId: 'rex' }), message({ author: 'bot', botId: 'ana', authorName: 'Ana' })], [])
    expect(rows[0]!.continuesNext).toBe(false)
  })
})
