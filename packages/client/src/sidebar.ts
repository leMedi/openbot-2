import { type BotInfo, type ChatInfo, isMuted, type MuteDuration, previewText, type SectionInfo, unassignedSectionId } from '@openbot/api-contract'

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

const isImage = (file: { mimeType: string }) => file.mimeType.startsWith('image/') && file.mimeType !== 'image/svg+xml'

/** Grok's sidebar summary of a message with files and no text: "Sent 2 images", "Sent a file". */
export function summarizeAttachments(attachments: readonly { mimeType: string }[]): string {
  const count = attachments.length
  const kind = attachments.every(isImage) ? 'image' : attachments.every((file) => file.mimeType.startsWith('video/')) ? 'video' : 'file'
  return count === 1 ? `Sent ${kind === 'image' ? 'an image' : `a ${kind}`}` : `Sent ${count} ${kind}s`
}

/** A row's second line: its text in a tone, after a label in its own (the draft's red, the wait's amber). */
export type RowLine = { label?: { text: string; tone: 'draft' | 'waiting' }; text: string; tone: 'muted' | 'working' | 'error' }

/**
 * The row's second line, in Grok's priority: the owner's draft, what the bot waits for, its activity (in a group, the
 * member taking its turn, `speaking`), the latest message.
 */
export function rowLine(row: Pick<SidebarRow, 'bot' | 'chat'>, speaking: BotInfo | undefined, draft: string | undefined): RowLine {
  const { bot, chat } = row
  if (draft?.trim()) return { label: { text: 'Draft: ', tone: 'draft' }, text: previewText(draft), tone: 'muted' }
  if (chat?.waitingFor) return { label: { text: 'Waiting for you: ', tone: 'waiting' }, text: previewText(chat.waitingFor), tone: 'muted' }
  if (bot?.working) return { text: 'Working…', tone: 'working' }
  if (bot?.error) return { text: "Couldn't reach its model", tone: 'error' }
  if (speaking) return { text: `${speaking.name} is taking a turn…`, tone: 'working' }
  const last = chat?.lastMessage
  if (last) {
    const text = previewText(last.text) || (last.attachments.length ? summarizeAttachments(last.attachments) : '')
    // A message between bots shows who it went to or came from: "→ Ana: …", "← Rex: …"; a group's shows who posted it.
    const prefix = last.botMessage
      ? `${last.botMessage.direction === 'to' ? '→' : '←'} ${last.botMessage.name}: `
      : last.author === 'owner'
        ? 'You: '
        : bot
          ? ''
          : `${last.authorName}: `
    return { text: prefix + text, tone: 'muted' }
  }
  return { text: bot?.title ?? 'No messages yet', tone: 'muted' }
}

/** A row's status dot: the chat waits for the owner, or a bot posted since they looked (unless they're reading it now). */
export function rowStatus(chat: ChatInfo | undefined, reading = false): 'attention' | 'unread' | undefined {
  if (chat?.waitingFor) return 'attention'
  if (chat?.unread && !reading) return 'unread'
  return undefined
}

/** The mute durations a chat's menu offers, in order, as both apps word them. */
export const muteChoices: readonly (readonly [MuteDuration, string])[] = [
  ['1h', 'For 1 hour'],
  ['8h', 'For 8 hours'],
  ['1d', 'For 1 day'],
  ['forever', 'Until I unmute'],
]

/** When a timed mute ends, as both apps say it: "Tue 5:30 PM". */
export function muteEnd(mutedUntil: number): string {
  return new Date(mutedUntil).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** Whether a chat's bot messages notify, in words for its info screen: Off, Until Tue 5:30 PM, Until I unmute, Hidden. */
export function muteState(chat: Pick<ChatInfo, 'mutedUntil' | 'hidden'>, now: number): { muted: boolean; label: string } {
  if (chat.hidden) return { muted: true, label: 'Hidden' }
  if (!isMuted(chat, now)) return { muted: false, label: 'Off' }
  return { muted: true, label: typeof chat.mutedUntil === 'number' ? `Until ${muteEnd(chat.mutedUntil)}` : 'Until I unmute' }
}

/** The app's badge: the chats unread or with a card waiting, as the instance counts it for each push. */
export function badgeCount(chats: Iterable<Pick<ChatInfo, 'unread' | 'waitingFor'>>): number {
  let count = 0
  for (const chat of chats) if (chat.unread || chat.waitingFor !== null) count++
  return count
}
