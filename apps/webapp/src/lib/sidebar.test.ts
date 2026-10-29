import type { BotInfo, ChatInfo, SectionInfo } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { adjacentChat, hiddenFoldKey, navigableChatIds, rangeBetween, selectableChatIds, type SidebarLayout, sidebarLayout } from './sidebar.ts'

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
