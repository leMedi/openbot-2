import type { MessageHit } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { hitDetail, rankByMatch, relativeTime } from './palette.ts'

describe('matching palette entries', () => {
  const names = ['Rex', 'Ana', 'Release team', 'Settings: Providers', 'Café ops']

  it('keeps entries with every word, those starting with it first, then a word starting with it', () => {
    expect(rankByMatch(names, (name) => name, 'se')).toEqual(['Settings: Providers', 'Release team'])
    expect(rankByMatch(names, (name) => name, 're')).toEqual(['Rex', 'Release team'])
    expect(rankByMatch(names, (name) => name, 'team rel')).toEqual(['Release team'])
    expect(rankByMatch(names, (name) => name, 'prov')).toEqual(['Settings: Providers'])
  })

  it('ignores case and accents, and keeps everything in order for a blank query', () => {
    expect(rankByMatch(names, (name) => name, 'CAFE')).toEqual(['Café ops'])
    expect(rankByMatch(names, (name) => name, '  ')).toEqual(names)
  })
})

describe('describing a search hit', () => {
  const now = Date.UTC(2026, 9, 29, 12)
  const hit = (changes: Partial<MessageHit>): MessageHit => ({
    messageId: 'm1',
    chatId: 'c1',
    author: 'owner',
    authorName: 'You',
    botMessage: null,
    createdAt: now - 5 * 60_000,
    snippet: [],
    ...changes,
  })

  it('says who wrote to whom in a DM, and which group chat a message is in, and when', () => {
    expect(hitDetail(hit({}), { kind: 'dm', name: 'Rex' }, now)).toBe('You to Rex · 5m ago')
    expect(hitDetail(hit({ author: 'bot', authorName: 'Rex', createdAt: now - 2 * 3_600_000 }), { kind: 'dm', name: 'Rex' }, now)).toBe('Rex to you · 2h ago')
    expect(hitDetail(hit({ author: 'bot', authorName: 'Rex', botMessage: { direction: 'to', botId: 'b2', name: 'Ana' } }), { kind: 'dm', name: 'Rex' }, now)).toBe(
      'Rex to Ana · 5m ago',
    )
    expect(hitDetail(hit({ author: 'bot', authorName: 'Ana', createdAt: now }), { kind: 'group', name: 'Launch' }, now)).toBe('In Launch · now')
  })

  it("writes Grok's compact relative times", () => {
    expect(relativeTime(now - 30_000, now)).toBe('now')
    expect(relativeTime(now - 59 * 60_000, now)).toBe('59m')
    expect(relativeTime(now - 25 * 3_600_000, now)).toBe('1d')
  })
})
