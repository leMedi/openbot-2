import type { MessageInfo } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { ownerReacted, reactionPills, reactorNames, replyTargetOf } from './reactions.ts'

const message = (fields: Partial<MessageInfo>): MessageInfo => ({
  id: 'm1',
  chatId: 'chat',
  author: 'bot',
  botId: 'rex',
  authorName: 'Rex',
  text: '',
  attachments: [],
  card: null,
  botMessage: null,
  reactions: [],
  replyTo: null,
  createdAt: 0,
  ...fields,
})

describe("a message's reaction pills", () => {
  it('counts each emoji once, in the order first left, marking those the owner left', () => {
    expect(
      reactionPills([
        { emoji: '👍', by: 'rex' },
        { emoji: '❤️', by: 'owner' },
        { emoji: '👍', by: 'owner' },
        { emoji: '👍', by: 'ana' },
      ]),
    ).toEqual([
      { emoji: '👍', count: 3, mine: true, by: ['rex', 'owner', 'ana'] },
      { emoji: '❤️', count: 1, mine: true, by: ['owner'] },
    ])
    expect(reactionPills([])).toEqual([])
  })

  it('are none for a message from a server older than reactions', () => {
    expect(reactionPills(undefined)).toEqual([])
    expect(ownerReacted({}, '👍')).toBe(false)
  })

  it('names who left a pill, the owner as You first, a bot gone as Deleted bot', () => {
    const bots = [{ id: 'rex', name: 'Rex' }]
    expect(reactorNames({ by: ['rex', 'owner', 'gone'] }, bots)).toBe('You, Rex, Deleted bot')
  })
})

describe('what a reply quotes', () => {
  it("is the message's text on one line, cut as the server cuts it, or its files' names", () => {
    expect(replyTargetOf(message({ text: 'Fixed **the build**:\n\n- `pnpm i`' }))).toEqual({
      id: 'm1',
      author: 'bot',
      botId: 'rex',
      authorName: 'Rex',
      text: 'Fixed **the build**: - `pnpm i`',
    })
    const files = message({ author: 'owner', botId: null, authorName: 'You', attachments: [{ id: 'a', name: 'plan.pdf', mimeType: 'application/pdf', size: 1, path: '' }] })
    expect(replyTargetOf(files)).toMatchObject({ author: 'owner', text: 'plan.pdf' })
    expect(replyTargetOf(message({ text: 'a'.repeat(300) })).text).toBe(`${'a'.repeat(280)}…`)
  })
})
