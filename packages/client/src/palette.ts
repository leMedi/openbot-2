import type { ApiClient, BotInfo, ChatInfo, FileHit, MessageHit, RoutineInfo, SearchResults } from '@openbot/api-contract'
import { useEffect, useState } from 'react'
import { describeSchedule } from './schedule.ts'

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

/** The search tabs both apps show, in order: Grok's, with bots and groups as Chats, and without Links. */
export const searchTabs = ['all', 'messages', 'chats', 'files', 'routines'] as const
/** A search tab: all hits, or one kind. */
export type SearchTab = (typeof searchTabs)[number]

/** Each search tab's chip label. */
export const searchTabLabels: Record<SearchTab, string> = { all: 'All', messages: 'Messages', chats: 'Chats', files: 'Files', routines: 'Routines' }

/** A chat's name, as the sidebar shows it: its bot's, or the group's. */
export function chatName(bots: readonly BotInfo[] | undefined, chat: ChatInfo): string {
  return chat.kind === 'dm' ? (bots?.find((bot) => bot.id === chat.botId)?.name ?? '') : (chat.name ?? '')
}

/** A chat found by its name, with its detail line ("Bot", "Group · Hidden"). */
export type ChatHit = { chat: ChatInfo; name: string; detail: string }
/** A routine found by its name or its bot's, with its detail line (its bot and schedule). */
export type RoutineHit = { routine: RoutineInfo; detail: string }
/** A message the server found, in its chat, with its detail line ("Rex to you · 5m ago"). */
export type MessageHitIn = { hit: MessageHit; chat: ChatInfo; name: string; detail: string }
/** A file the server found, in its chat, with its detail line (the chat's name). */
export type FileHitIn = { hit: FileHit; chat: ChatInfo; name: string; detail: string }
/** What a search found, by kind. */
export type SearchHits = { chats: ChatHit[]; routines: RoutineHit[]; messages: MessageHitIn[]; files: FileHitIn[] }

/**
 * What a search finds, as the web's palette and the phone's search show it: chats by name (the latest active first
 * among equal matches, hidden ones included), routines by their name or their bot's, and the server's message and
 * file hits (`found`, for `query`) in the chats the store knows, each with its detail line.
 */
export function searchHits({
  bots,
  chats,
  routines,
  found,
  query,
  now,
}: {
  bots: readonly BotInfo[] | undefined
  chats: ReadonlyMap<string, ChatInfo>
  routines: readonly RoutineInfo[]
  found: SearchResults | undefined
  query: string
  now: number
}): SearchHits {
  const named = [...chats.values()]
    .flatMap((chat) => {
      const name = chatName(bots, chat)
      return name ? [{ chat, name }] : []
    })
    .sort((a, b) => (b.chat.lastMessage?.createdAt ?? 0) - (a.chat.lastMessage?.createdAt ?? 0))
  const kind = (chat: ChatInfo) => (chat.kind === 'dm' ? 'Bot' : 'Group')
  const botNames = new Map((bots ?? []).map((bot) => [bot.id, bot.name]))
  const inChat = <T extends MessageHit | FileHit>(hit: T) => {
    const chat = chats.get(hit.chatId)
    return chat ? [{ hit, chat, name: chatName(bots, chat) }] : []
  }
  return {
    chats: rankByMatch(named, (entry) => entry.name, query).map(({ chat, name }) => ({
      chat,
      name,
      detail: chat.hidden ? `${kind(chat)} · Hidden` : kind(chat),
    })),
    routines: rankByMatch(routines, (routine) => `${routine.name} ${botNames.get(routine.botId) ?? ''}`, query).map((routine) => ({
      routine,
      detail: [botNames.get(routine.botId), routine.enabled ? describeSchedule(routine.schedule) : 'Paused'].filter(Boolean).join(' · '),
    })),
    messages: (found?.messages ?? []).flatMap(inChat).map((entry) => ({ ...entry, detail: hitDetail(entry.hit, { kind: entry.chat.kind, name: entry.name }, now) })),
    files: (found?.files ?? []).flatMap(inChat).map((entry) => ({ ...entry, detail: entry.name })),
  }
}

/** How many hits of each kind the All tab shows once typed, and how many chats before. */
const allTabLimit = 5
const allTabChats = 8

/**
 * The rows of a search tab, under their headings on All: up to 5 of each kind once something is typed (8 chats
 * before); a kind's own tab shows them all, messages and files only once something is typed.
 */
export function searchSections<C, R, M, F>(
  hits: { chats: C[]; routines: R[]; messages: M[]; files: F[] },
  tab: SearchTab,
  query: string,
): { heading?: string; entries: (C | R | M | F)[] }[] {
  const typed = !!query.trim()
  if (tab === 'all') {
    if (!typed) return [{ heading: 'Chats', entries: hits.chats.slice(0, allTabChats) }]
    return [
      { heading: 'Chats', entries: hits.chats.slice(0, allTabLimit) },
      { heading: 'Routines', entries: hits.routines.slice(0, allTabLimit) },
      { heading: 'Messages', entries: hits.messages.slice(0, allTabLimit) },
      { heading: 'Files', entries: hits.files.slice(0, allTabLimit) },
    ]
  }
  const entries = { chats: hits.chats, routines: hits.routines, messages: typed ? hits.messages : [], files: typed ? hits.files : [] }[tab]
  return [{ entries }]
}

/** How long typing pauses before the server is searched. */
const searchDelayMs = 150

/** What a search has read from the instance so far. */
export type SearchSources = {
  /** Every bot's routines, once read. */
  routines: RoutineInfo[] | undefined
  /** The server's message and file hits for the query as typed now, once they arrive. */
  found: SearchResults | undefined
  /** The server's search failed for the query as typed now. */
  failed: boolean
}

/**
 * What a search reads from the instance while open: every bot's routines, once, and the server's message and file
 * search for `query` once typing pauses, when `server` (a tab showing messages or files).
 */
export function useSearchSources(api: ApiClient, bots: readonly BotInfo[] | undefined, query: string, server: boolean): SearchSources {
  const [routines, setRoutines] = useState<RoutineInfo[]>()
  const [results, setResults] = useState<{ query: string; found: SearchResults } | { query: string; failed: true }>()

  // `bots` changes on every status update; only the bots themselves matter here.
  const botIds = (bots ?? []).map((bot) => bot.id).join()
  useEffect(() => {
    let current = true
    Promise.all(botIds ? botIds.split(',').map((botId) => api.routines.list({ botId })) : [])
      .then((lists) => current && setRoutines(lists.flat()))
      .catch(() => current && setRoutines([]))
    return () => {
      current = false
    }
  }, [api, botIds])

  const trimmed = query.trim()
  useEffect(() => {
    if (!server || !trimmed) return
    let current = true
    const timer = setTimeout(() => {
      api.chats.search({ query: trimmed }).then(
        (found) => current && setResults({ query: trimmed, found }),
        () => current && setResults({ query: trimmed, failed: true }),
      )
    }, searchDelayMs)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [api, trimmed, server])

  const forQuery = results?.query === trimmed ? results : undefined
  return { routines, found: forQuery && 'found' in forQuery ? forQuery.found : undefined, failed: !!forQuery && 'failed' in forQuery }
}

/** Whether a tab searches the server: those showing messages or files. */
export const searchesServer = (tab: SearchTab) => tab === 'all' || tab === 'messages' || tab === 'files'

/** What an empty search tab says. */
export function searchEmptyText({ tab, query, sources, chats }: { tab: SearchTab; query: string; sources: SearchSources; chats: number }): string {
  const typed = !!query.trim()
  if (sources.failed) return 'Search unavailable — Try again in a moment.'
  if (tab === 'messages' && !typed) return 'Search messages'
  if (tab === 'files' && !typed) return 'Search files'
  if (tab === 'routines' && !typed && sources.routines?.length === 0) return 'No routines yet'
  if (tab === 'chats' && !chats) return 'No chats yet'
  if (searchesServer(tab) && typed && !sources.found) return 'Searching…'
  return 'No results'
}
