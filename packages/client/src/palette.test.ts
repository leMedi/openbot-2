import type { BotInfo, ChatInfo, FileHit, MessageHit, RoutineInfo, SearchResults } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { hitDetail, rankByMatch, relativeTime, searchHits, searchSections } from './palette.ts'

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

describe('search hits', () => {
  const now = Date.UTC(2026, 9, 29, 12)
  const rex: BotInfo = {
    id: 'b-rex',
    name: 'Rex',
    title: null,
    instructions: '',
    avatarStyle: 'critter',
    avatarShape: 'blob',
    avatarColor: 'blue',
    model: null,
    chatId: 'c-rex',
    working: false,
    error: null,
  }
  const ana: BotInfo = { ...rex, id: 'b-ana', name: 'Ana', chatId: 'c-ana' }
  const chat = (id: string, changes: Partial<ChatInfo>): ChatInfo => ({
    id,
    kind: 'dm',
    botId: null,
    name: null,
    title: null,
    members: [],
    speaking: null,
    pinnedPosition: null,
    sectionId: 'unassigned',
    hidden: false,
    mutedUntil: null,
    unread: false,
    waitingFor: null,
    lastMessage: null,
    ...changes,
  })
  const last = (createdAt: number) => ({ author: 'owner' as const, authorName: 'You', text: '', attachments: [], botMessage: null, createdAt })
  const chats = new Map([
    ['c-rex', chat('c-rex', { botId: 'b-rex', lastMessage: last(now - 60_000) })],
    ['c-ana', chat('c-ana', { botId: 'b-ana', hidden: true, lastMessage: last(now - 1000) })],
    ['c-launch', chat('c-launch', { kind: 'group', name: 'Release crew', members: ['b-rex', 'b-ana'] })],
  ])
  const routine = (id: string, name: string, botId: string, enabled = true): RoutineInfo => ({
    id,
    botId,
    name,
    prompt: '',
    schedule: '0 8 * * *',
    enabled,
    nextRunAt: null,
    createdBy: 'owner',
  } as RoutineInfo)
  const hitIn = (chatId: string, messageId: string, changes: Partial<MessageHit> = {}): MessageHit => ({
    messageId,
    chatId,
    author: 'owner',
    authorName: 'You',
    botMessage: null,
    createdAt: now - 5 * 60_000,
    snippet: [{ text: 'deploy', match: true }],
    ...changes,
  })

  it('finds chats by name, the latest active first, hidden ones said so', () => {
    const found = searchHits({ bots: [rex, ana], chats, routines: [], found: undefined, query: '', now })
    expect(found.chats.map((hit) => [hit.name, hit.detail])).toEqual([
      ['Ana', 'Bot · Hidden'],
      ['Rex', 'Bot'],
      ['Release crew', 'Group'],
    ])
    expect(searchHits({ bots: [rex, ana], chats, routines: [], found: undefined, query: 're', now }).chats.map((hit) => hit.name)).toEqual(['Rex', 'Release crew'])
  })

  it("finds routines by their name or their bot's, with the bot and the schedule", () => {
    const routines = [routine('r1', 'Morning digest', 'b-rex'), routine('r2', 'Fare watch', 'b-ana', false)]
    const found = searchHits({ bots: [rex, ana], chats, routines, found: undefined, query: 'ana', now })
    expect(found.routines.map((hit) => [hit.routine.id, hit.detail])).toEqual([['r2', 'Ana · Paused']])
    expect(searchHits({ bots: [rex, ana], chats, routines, found: undefined, query: 'digest', now }).routines[0]?.detail).toMatch(/^Rex · /)
  })

  it("shows the server's message and file hits in their chats, leaving out chats it doesn't know", () => {
    const results: SearchResults = {
      messages: [hitIn('c-rex', 'm1'), hitIn('c-gone', 'm2')],
      files: [{ ...hitIn('c-launch', 'm3'), attachment: { id: 'a1', name: 'plan.pdf', mimeType: 'application/pdf', size: 10, path: '/tmp/plan.pdf' } }],
    }
    const found = searchHits({ bots: [rex, ana], chats, routines: [], found: results, query: 'deploy', now })
    expect(found.messages.map((hit) => [hit.hit.messageId, hit.chat.id, hit.detail])).toEqual([['m1', 'c-rex', 'You to Rex · 5m ago']])
    expect(found.files.map((hit) => [hit.hit.attachment.name, hit.chat.id, hit.detail])).toEqual([['plan.pdf', 'c-launch', 'Release crew']])
  })
})

describe('search sections', () => {
  const entries = (n: number, kind: string) => Array.from({ length: n }, (_, index) => `${kind}${index}`)
  const hits = { chats: entries(9, 'c'), routines: entries(2, 'r'), messages: entries(7, 'm'), files: [] as string[] }

  it('shows up to 5 of each kind on All once typed, and 8 chats before', () => {
    expect(searchSections(hits, 'all', 'x').map((section) => [section.heading, section.entries.length])).toEqual([
      ['Chats', 5],
      ['Routines', 2],
      ['Messages', 5],
      ['Files', 0],
    ])
    expect(searchSections(hits, 'all', '').map((section) => [section.heading, section.entries.length])).toEqual([['Chats', 8]])
  })

  it('shows every hit of one kind on its tab, messages and files only once typed', () => {
    expect(searchSections(hits, 'chats', '')[0]?.entries).toHaveLength(9)
    expect(searchSections(hits, 'messages', '')[0]?.entries).toHaveLength(0)
    expect(searchSections(hits, 'messages', 'x')[0]?.entries).toHaveLength(7)
  })
})
