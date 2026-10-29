import type { MessageHit } from '@openbot/api-contract'

/** The palette's tabs, in order: Grok's, with bots and groups as Chats, and without Links. */
export const paletteTabs = ['all', 'messages', 'chats', 'files', 'routines', 'actions'] as const
export type PaletteTab = (typeof paletteTabs)[number]

/** Lower case, without accents, so "cafe" finds "Café". */
const folded = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Whether a word of `haystack` other than its first starts with `word`. */
function startsAWord(haystack: string, word: string): boolean {
  for (let at = haystack.indexOf(word, 1); at !== -1; at = haystack.indexOf(word, at + 1)) {
    if (!/[\p{L}\p{N}]/u.test(haystack[at - 1]!)) return true
  }
  return false
}

/**
 * How well `text` matches every word of `query`: 0 per word it starts with, 1 per word one of its words starts with,
 * 2 per word found inside; undefined when a word is missing.
 */
function matchScore(text: string, words: readonly string[]): number | undefined {
  const haystack = folded(text)
  let score = 0
  for (const word of words) {
    if (haystack.startsWith(word)) continue
    if (startsAWord(haystack, word)) score += 1
    else if (haystack.includes(word)) score += 2
    else return undefined
  }
  return score
}

/** The `items` whose label has every word of `query`, best matches first; all of them, in order, for a blank query. */
export function rankByMatch<T>(items: readonly T[], label: (item: T) => string, query: string): T[] {
  const words = folded(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...items]
  return items
    .flatMap((item) => {
      const score = matchScore(label(item), words)
      return score === undefined ? [] : [{ item, score }]
    })
    .sort((a, b) => a.score - b.score)
    .map(({ item }) => item)
}

/** Grok's compact relative time: now, 5m, 3h, 2d. */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** A search hit's detail, as Grok's palette shows it: "You to Rex · 5m ago", "Rex to you · 2h ago", "In Launch · now". */
export function hitDetail(hit: Pick<MessageHit, 'author' | 'authorName' | 'botMessage' | 'createdAt'>, chat: { kind: 'dm' | 'group'; name: string }, now: number) {
  const when = relativeTime(hit.createdAt, now)
  const ago = when === 'now' ? when : `${when} ago`
  if (chat.kind === 'group') return `In ${chat.name} · ${ago}`
  if (hit.botMessage) {
    const [from, to] = hit.botMessage.direction === 'to' ? [hit.authorName, hit.botMessage.name] : [hit.botMessage.name, hit.authorName]
    return `${from} to ${to} · ${ago}`
  }
  return hit.author === 'owner' ? `You to ${chat.name} · ${ago}` : `${hit.authorName} to you · ${ago}`
}
