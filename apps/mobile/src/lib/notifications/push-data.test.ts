import { describe, expect, it } from 'vitest'
import { pushDataOf } from './push-data.ts'

describe("a notification's data", () => {
  const sent = { chatId: 'c1', messageId: 'm1', kind: 'take_over', botId: 'b1', botName: 'Rex', group: false, quiet: false }

  it("reads what the instance sends, a card's or a message's", () => {
    expect(pushDataOf(sent)).toEqual(sent)
    expect(pushDataOf({ ...sent, kind: 'message', group: true, quiet: true })).toMatchObject({ kind: 'message', group: true, quiet: true })
  })

  it('reads an older instance’s data, without the sender', () => {
    expect(pushDataOf({ chatId: 'c1', messageId: 'm1', kind: 'question' })).toEqual({ chatId: 'c1', messageId: 'm1', kind: 'question', botId: '', botName: '', group: false, quiet: false })
  })

  it("isn't fooled by another notification's", () => {
    expect(pushDataOf(undefined)).toBeUndefined()
    expect(pushDataOf({})).toBeUndefined()
    expect(pushDataOf({ chatId: 'c1', messageId: 'm1', kind: 'party' })).toBeUndefined()
    expect(pushDataOf({ chatId: 3, messageId: 'm1', kind: 'message' })).toBeUndefined()
  })
})
