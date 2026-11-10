import type { BotInfo, ChatInfo, SectionInfo } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { adjacentChat, badgeCount, hiddenFoldKey, muteState, navigableChatIds, rangeBetween, rowLine, selectableChatIds, type SidebarLayout, sidebarLayout } from './sidebar.ts'

const chat = (id: string, changes: Partial<ChatInfo> = {}): ChatInfo => ({
  id,
  kind: 'dm',
  botId: `bot-${id}`,
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

const bot = (chatId: string): BotInfo =>
  ({ id: `bot-${chatId}`, chatId, name: chatId.toUpperCase() }) as BotInfo

const unassigned: SectionInfo = { id: 'unassigned', name: null }
const work: SectionInfo = { id: 'work', name: 'Work' }
const home: SectionInfo = { id: 'home', name: 'Home' }

/** The layout of DMs `chats` (ids are their age order) and group chats `groups`. */
function layoutOf(chats: ChatInfo[], sections: SectionInfo[] = [unassigned], folds: Record<string, boolean> = {}) {
  const dms = chats.filter((entry) => entry.kind === 'dm')
  return sidebarLayout(
    dms.map((entry) => bot(entry.id)),
    new Map(chats.map((entry) => [entry.id, entry])),
    sections,
    folds,
  )
}

/** Each block as "header: chat ids", "(folded)" when folded. */
const outline = (layout: SidebarLayout) =>
  layout.blocks.map((block) => {
    const name = block.kind === 'pinned' ? 'Pinned' : block.kind === 'hidden' ? 'Hidden' : (block.section.name ?? 'Unassigned')
    const folded = block.kind !== 'pinned' && block.folded ? ' (folded)' : ''
    return `${name}${folded}: ${block.rows.map((row) => row.chatId).join(' ')}`
  })

describe('the sidebar layout', () => {
  it('is flat, without headers, with no sections and nothing hidden', () => {
    const layout = layoutOf([chat('a'), chat('b', { pinnedPosition: 0 }), chat('c')])

    expect(layout.headers).toBe(false)
    expect(outline(layout)).toEqual(['Pinned: b', 'Unassigned: a c'])
  })

  it("puts pinned chats first, then sections and Unassigned in the owner's order, then Hidden", () => {
    const layout = layoutOf(
      [
        chat('a', { sectionId: 'work' }),
        chat('b', { pinnedPosition: 1 }),
        chat('c'),
        chat('d', { hidden: true, sectionId: 'home' }),
        chat('e', { pinnedPosition: 0, sectionId: 'work' }),
        chat('g', { kind: 'group', botId: null, name: 'Team', sectionId: 'home' }),
      ],
      [work, unassigned, home],
    )

    expect(layout.headers).toBe(true)
    expect(outline(layout)).toEqual(['Pinned: e b', 'Work: a', 'Unassigned: c', 'Home: g', 'Hidden (folded): d'])
  })

  it('shows an empty section of the owner\'s, but not an empty Unassigned or Hidden', () => {
    const layout = layoutOf([chat('a', { sectionId: 'work' })], [home, unassigned, work])

    expect(outline(layout)).toEqual(['Home: ', 'Work: a'])
  })

  it('has headers once a chat is hidden, even with no sections', () => {
    const layout = layoutOf([chat('a'), chat('b', { hidden: true })])

    expect(layout.headers).toBe(true)
    expect(outline(layout)).toEqual(['Unassigned: a', 'Hidden (folded): b'])
  })

  it('folds what the owner folded, Hidden until they unfold it', () => {
    const layout = layoutOf([chat('a', { sectionId: 'work' }), chat('b', { hidden: true })], [work, unassigned], {
      work: true,
      [hiddenFoldKey]: false,
    })

    expect(outline(layout)).toEqual(['Work (folded): a', 'Hidden: b'])
  })

  it('puts a chat whose section is gone in Unassigned', () => {
    expect(outline(layoutOf([chat('a', { sectionId: 'gone' })], [work, unassigned]))).toEqual(['Work: ', 'Unassigned: a'])
  })
})

describe('moving through the sidebar', () => {
  const layout = layoutOf(
    [chat('a', { sectionId: 'work' }), chat('b', { pinnedPosition: 0 }), chat('c'), chat('d', { sectionId: 'home' }), chat('e', { hidden: true })],
    [work, home, unassigned],
    { home: true, [hiddenFoldKey]: false },
  )

  it('goes through the chats shown, skipping folded sections and Hidden', () => {
    expect(navigableChatIds(layout)).toEqual(['b', 'a', 'c'])
    expect(adjacentChat(navigableChatIds(layout), 'a', 1)).toBe('c')
    expect(adjacentChat(navigableChatIds(layout), 'b', -1)).toBe('c')
    expect(adjacentChat(navigableChatIds(layout), 'c', 1)).toBe('b')
    expect(adjacentChat(navigableChatIds(layout), undefined, 1)).toBe('b')
    expect(adjacentChat([], undefined, 1)).toBeUndefined()
  })

  it('selects a range among the chats shown, Hidden ones too when unfolded', () => {
    expect(selectableChatIds(layout)).toEqual(['b', 'a', 'c', 'e'])
    expect(rangeBetween(selectableChatIds(layout), 'e', 'a')).toEqual(['a', 'c', 'e'])
    expect(rangeBetween(selectableChatIds(layout), 'a', 'a')).toEqual(['a'])
    expect(rangeBetween(selectableChatIds(layout), 'd', 'c')).toEqual(['c'])
  })
})

describe("a row's second line", () => {
  const rex = { ...bot('rex'), name: 'Rex', title: 'Builder', working: false, error: null } as BotInfo
  const last = (changes: Partial<NonNullable<ChatInfo['lastMessage']>>): ChatInfo['lastMessage'] => ({
    author: 'bot',
    authorName: 'Rex',
    text: 'Done, **green**.',
    attachments: [],
    botMessage: null,
    createdAt: 0,
    ...changes,
  })
  const dm = (changes: Partial<ChatInfo> = {}) => ({ chatId: 'rex', bot: rex, chat: chat('rex', changes), pinned: false })

  it("puts the owner's draft first, then what waits for them, then the bot's activity, then the latest message", () => {
    const waiting = dm({ waitingFor: 'Which **database**?', lastMessage: last({}) })
    expect(rowLine(waiting, undefined, 'half a *thought*')).toEqual({ label: { text: 'Draft: ', tone: 'draft' }, text: 'half a thought', tone: 'muted' })
    expect(rowLine(waiting, undefined, '  ')).toEqual({ label: { text: 'Waiting for you: ', tone: 'waiting' }, text: 'Which database?', tone: 'muted' })
    expect(rowLine({ ...dm({ lastMessage: last({}) }), bot: { ...rex, working: true } }, undefined, undefined)).toEqual({ text: 'Working…', tone: 'working' })
    expect(rowLine({ ...dm(), bot: { ...rex, error: 'boom' } }, undefined, undefined)).toEqual({ text: "Couldn't reach its model", tone: 'error' })
    expect(rowLine(dm({ lastMessage: last({}) }), undefined, undefined)).toEqual({ text: 'Done, green.', tone: 'muted' })
    expect(rowLine(dm(), undefined, undefined)).toEqual({ text: 'Builder', tone: 'muted' })
  })

  it('says who wrote the latest message, and sums up files sent alone', () => {
    expect(rowLine(dm({ lastMessage: last({ author: 'owner', authorName: 'You', text: 'Hi' }) }), undefined, undefined).text).toBe('You: Hi')
    expect(rowLine(dm({ lastMessage: last({ botMessage: { direction: 'to', botId: 'b', name: 'Ana' } }) }), undefined, undefined).text).toBe('→ Ana: Done, green.')
    const group = { chatId: 'g', chat: chat('g', { kind: 'group', lastMessage: last({ text: '' , attachments: [{ id: 'a', name: 'a.png', mimeType: 'image/png', size: 1, path: '/a' }, { id: 'b', name: 'b.png', mimeType: 'image/png', size: 1, path: '/b' }] }) }), pinned: false }
    expect(rowLine(group, undefined, undefined).text).toBe('Rex: Sent 2 images')
    expect(rowLine(group, { ...rex, name: 'Ana' }, undefined)).toEqual({ text: 'Ana is taking a turn…', tone: 'working' })
  })
})

describe('the app badge', () => {
  it('counts the chats unread or with a card waiting, each once, hidden ones included', () => {
    const chats = [
      chat('a', { unread: true }),
      chat('b', { waitingFor: 'Which database?' }),
      chat('c', { unread: true, waitingFor: 'Sign in' }),
      chat('d'),
      chat('e', { unread: true, hidden: true }),
    ]
    expect(badgeCount(chats)).toBe(4)
    expect(badgeCount([])).toBe(0)
  })
})

describe("a chat's mute, in words", () => {
  const now = new Date(2026, 10, 10, 9, 0).getTime()
  it('says when it ends, or that it lasts until unmuted', () => {
    expect(muteState(chat('a'), now)).toEqual({ muted: false, label: 'Off' })
    expect(muteState(chat('a', { mutedUntil: now - 1 }), now)).toEqual({ muted: false, label: 'Off' })
    expect(muteState(chat('a', { mutedUntil: 'forever' }), now)).toEqual({ muted: true, label: 'Until I unmute' })
    const later = muteState(chat('a', { mutedUntil: new Date(2026, 10, 10, 17, 30).getTime() }), now)
    expect(later.muted).toBe(true)
    expect(later.label).toMatch(/^Until .*5:30/)
  })

  it('counts a hidden chat as muted, its own mute aside', () => {
    expect(muteState(chat('a', { hidden: true }), now)).toEqual({ muted: true, label: 'Hidden' })
  })
})
