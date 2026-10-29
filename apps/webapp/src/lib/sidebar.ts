import { type BotInfo, type ChatInfo, type SectionInfo, unassignedSectionId } from '@openbot/api-contract'

/** One sidebar row: a bot's DM (with its bot) or a group chat. */
export type SidebarRow = { chatId: string; chat: ChatInfo | undefined; pinned: boolean; bot?: BotInfo }

/** The key folding the Hidden section, among the sections' ids. */
export const hiddenFoldKey = 'hidden'

/** A run of rows under one header: pinned chats (no header), a section, or Hidden. */
export type SidebarBlock =
  | { kind: 'pinned'; rows: SidebarRow[] }
  | { kind: 'section'; section: SectionInfo; rows: SidebarRow[]; folded: boolean }
  | { kind: 'hidden'; rows: SidebarRow[]; folded: boolean }

export type SidebarLayout = {
  blocks: SidebarBlock[]
  /** Whether sections show their headers: once the owner has a section or a hidden chat. */
  headers: boolean
}

/** Whether a section or Hidden (`hiddenFoldKey`) is folded: as the owner left it, else Hidden folded and the rest open. */
const isFolded = (id: string, folds: Readonly<Record<string, boolean>>) => folds[id] ?? id === hiddenFoldKey

/**
 * The sidebar as Grok lays it out, with OpenBot's sections: pinned chats in the owner's order, then their sections
 * and Unassigned in their order, then Hidden. Within each, chats are oldest first, DMs and group chats alike. An empty
 * section of the owner's shows; an empty Unassigned or Hidden doesn't.
 */
export function sidebarLayout(
  bots: readonly BotInfo[],
  chats: ReadonlyMap<string, ChatInfo>,
  sections: readonly SectionInfo[],
  folds: Readonly<Record<string, boolean>>,
): SidebarLayout {
  const dms = bots.map((bot) => ({ chatId: bot.chatId, chat: chats.get(bot.chatId), bot }))
  const groupChats = [...chats.values()].filter((chat) => chat.kind === 'group').map((chat) => ({ chatId: chat.id, chat }))
  // Chat ids are time-ordered.
  const rows: SidebarRow[] = [...dms, ...groupChats]
    .map((row) => ({ ...row, pinned: !row.chat?.hidden && row.chat?.pinnedPosition != null }))
    .sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0))

  const pinned = rows.filter((row) => row.pinned).sort((a, b) => a.chat!.pinnedPosition! - b.chat!.pinnedPosition!)
  const hidden = rows.filter((row) => row.chat?.hidden)
  const known = new Set(sections.map((section) => section.id))
  const sectionOf = (row: SidebarRow) => (row.chat && known.has(row.chat.sectionId) ? row.chat.sectionId : unassignedSectionId)
  const rest = rows.filter((row) => !row.pinned && !row.chat?.hidden)
  const headers = sections.some((section) => section.id !== unassignedSectionId) || hidden.length > 0

  const blocks: SidebarBlock[] = []
  if (pinned.length) blocks.push({ kind: 'pinned', rows: pinned })
  for (const section of sections) {
    const inSection = rest.filter((row) => sectionOf(row) === section.id)
    if (section.id === unassignedSectionId && !inSection.length && (headers || !rest.length)) continue
    blocks.push({ kind: 'section', section, rows: inSection, folded: headers && isFolded(section.id, folds) })
  }
  if (hidden.length) blocks.push({ kind: 'hidden', rows: hidden, folded: isFolded(hiddenFoldKey, folds) })
  return { blocks, headers }
}

/** The chats ⌥↑ and ⌥↓ go through: those shown, top to bottom, leaving out Hidden. */
export function navigableChatIds(layout: SidebarLayout): string[] {
  return layout.blocks.flatMap((block) => (block.kind === 'hidden' || (block.kind === 'section' && block.folded) ? [] : block.rows.map((row) => row.chatId)))
}

/** The chats a Shift-click range can take in: those shown, top to bottom, Hidden ones too while unfolded. */
export function selectableChatIds(layout: SidebarLayout): string[] {
  return layout.blocks.flatMap((block) => (block.kind !== 'pinned' && block.folded ? [] : block.rows.map((row) => row.chatId)))
}

/** The chats from `anchor` to `target` in `order`, both included; only `target` when the anchor isn't shown. */
export function rangeBetween(order: readonly string[], anchor: string, target: string): string[] {
  const from = order.indexOf(anchor)
  const to = order.indexOf(target)
  if (from === -1 || to === -1) return [target]
  return order.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/** The chat `step` places from `current` in `order`, wrapping around; the first (or last) one when none is open. */
export function adjacentChat(order: readonly string[], current: string | undefined, step: 1 | -1): string | undefined {
  if (!order.length) return undefined
  const index = current === undefined ? -1 : order.indexOf(current)
  if (index === -1) return step === 1 ? order[0] : order.at(-1)
  return order[(index + step + order.length) % order.length]
}
