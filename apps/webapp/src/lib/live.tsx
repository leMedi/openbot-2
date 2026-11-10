import {
  type BotInfo,
  type ChatInfo,
  deletedAuthorName,
  type LiveEvent,
  maxMessagesPageSize,
  type MessageInfo,
  type MessagesPage,
  type SectionInfo,
  type StampedEvent,
  unassignedSectionId,
} from '@openbot/api-contract'
import { type ReactNode, createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from './api.ts'

const reconnectDelayMs = 1000
const draftKeyPrefix = 'openbot.draft.'

/** This browser's localStorage, or undefined where it's missing or blocked (reading the global can throw). */
function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** The drafts kept in `storage`, by chat id; none if storage is blocked. */
function loadDrafts(storage: Storage | undefined): Map<string, string> {
  const drafts = new Map<string, string>()
  if (!storage) return drafts
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(draftKeyPrefix)) continue
      const text = storage.getItem(key)
      if (text) drafts.set(key.slice(draftKeyPrefix.length), text)
    }
  } catch {
    // Storage blocked: drafts last until reload.
  }
  return drafts
}

/** Merges `incoming` into `messages`, once each, oldest first (ids are time-ordered). */
function mergeMessages(messages: readonly MessageInfo[], incoming: readonly MessageInfo[]): MessageInfo[] {
  const byId = new Map(messages.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Merges the latest page of a chat's messages into those loaded. When the page doesn't reach back to them (more arrived
 * meanwhile than a page holds), the older ones are dropped, as they no longer join up; `older` is then the page's cursor.
 */
function mergeLatest(
  messages: readonly MessageInfo[],
  older: string | null | undefined,
  page: MessagesPage,
): { messages: MessageInfo[]; older: string | null } {
  const latest = [...page.messages].reverse()
  const oldest = latest[0]?.id
  if (page.nextCursor === null || oldest === undefined) return { messages: mergeMessages(messages, latest), older: null }
  const before = messages.filter((message) => message.id < oldest)
  const joins = !before.length || messages.some((message) => message.id === oldest)
  if (!joins) return { messages: mergeMessages(messages.filter((message) => message.id >= oldest), latest), older: page.nextCursor }
  return { messages: mergeMessages(messages, latest), older: before.length && older !== undefined ? older : page.nextCursor }
}

/**
 * Bots, every chat's sidebar state, and the messages of opened chats, kept in sync with the server over the live event stream. A reconnect
 * resumes from the last stamp seen; when the server can't resume (a restart, or too long away), everything is refetched.
 */
export class LiveStore {
  bots: BotInfo[] | undefined
  /** Every chat's sidebar state (pinned, unread, waiting), by chat id. */
  chats: ReadonlyMap<string, ChatInfo> = new Map()
  /** The loaded messages of opened chats, oldest first: the latest page, and older ones as the owner scrolls back. */
  messages: ReadonlyMap<string, MessageInfo[]> = new Map()
  /** Per opened chat, the cursor of the page before its oldest loaded message; null once its first message is loaded. */
  #older = new Map<string, string | null>()
  /** Older pages loading, per chat, so scrolling asks for each one once. */
  #loadingOlder = new Map<string, Promise<void>>()
  /** The sidebar's sections, top first, Unassigned among them. */
  sections: readonly SectionInfo[] = [{ id: unassignedSectionId, name: null }]
  /** What the owner has typed but not sent, per chat; kept in this browser's storage, or while the app is open if it's blocked. */
  drafts: ReadonlyMap<string, string>
  connected = false
  #stamp: { epoch: string; seq: number } | undefined
  #listeners = new Set<() => void>()
  #eventListeners = new Set<(event: LiveEvent) => void>()
  #version = 0
  readonly #storage: Storage | undefined

  constructor(storage = browserStorage()) {
    this.#storage = storage
    this.drafts = loadDrafts(storage)
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Calls `listener` with every live event once the store applied it, for state kept outside the store, such as a
   * pane's. A `hello` that isn't `resumed` means events were lost: such state must be read anew.
   */
  listen(listener: (event: LiveEvent) => void) {
    this.#eventListeners.add(listener)
    return () => void this.#eventListeners.delete(listener)
  }

  /** Changes on every update, for `useSyncExternalStore`. */
  getVersion = () => this.#version

  /** Follows the event stream until `signal` aborts, reconnecting after errors. */
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const events = await api().events(this.#stamp, { signal })
        for await (const event of events) await this.#apply(event)
      } catch {
        // Disconnected; reconnect below.
      }
      this.#update(() => (this.connected = false))
      if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs))
    }
  }

  /** Loads a chat's latest messages, merging them with any that arrived live meanwhile. */
  async openChat(chatId: string) {
    // Registered first, so messages that arrive live while loading are kept.
    if (!this.messages.has(chatId)) this.#update(() => this.#setMessages(chatId, []))
    const page = await api().chats.messages({ chatId })
    this.#update(() => this.#mergeLatest(chatId, page))
  }

  /** Whether an opened chat has messages older than those loaded. */
  hasOlder(chatId: string): boolean {
    return typeof this.#older.get(chatId) === 'string'
  }

  /** Whether older messages of a chat are loading. */
  loadingOlder(chatId: string): boolean {
    return this.#loadingOlder.has(chatId)
  }

  /** Loads the page of an opened chat's messages before its oldest loaded one, if there is one. */
  loadOlder(chatId: string, limit?: number): Promise<void> {
    const cursor = this.#older.get(chatId)
    if (typeof cursor !== 'string') return Promise.resolve()
    const loading = this.#loadingOlder.get(chatId)
    if (loading) return loading
    const load = (async () => {
      let page: MessagesPage | undefined
      try {
        page = await api().chats.messages({ chatId, cursor, limit })
      } finally {
        this.#update(() => {
          this.#loadingOlder.delete(chatId)
          // Unless the chat was refetched or forgotten meanwhile, when this page may no longer join up.
          if (!page || this.#older.get(chatId) !== cursor) return
          this.#older.set(chatId, page.nextCursor)
          this.#setMessages(chatId, mergeMessages(this.messages.get(chatId) ?? [], page.messages))
        })
      }
    })()
    this.#update(() => this.#loadingOlder.set(chatId, load))
    return load
  }

  /** Loads an opened chat's older messages until `messageId` is among them, e.g. a search hit; or until none are left. */
  async loadUntil(chatId: string, messageId: string) {
    while (this.hasOlder(chatId) && !this.messages.get(chatId)?.some((message) => message.id === messageId)) {
      await this.loadOlder(chatId, maxMessagesPageSize)
    }
  }

  /** Adds or replaces a message the server returned, e.g. the owner's own, which also arrives live. */
  addMessage(message: MessageInfo) {
    this.#update(() => this.#setMessages(message.chatId, mergeMessages(this.messages.get(message.chatId) ?? [], [message])))
  }

  /** Shows a chat as the server returned it, e.g. after marking it read. */
  setChat(chat: ChatInfo) {
    this.#update(() => (this.chats = new Map(this.chats).set(chat.id, chat)))
  }

  /**
   * Marks a chat read up to `upTo`: at once here, then on the server. The server's answer arrives as `chat.updated`,
   * in order with the chat's other changes, so a bot posting meanwhile still shows; a failed save shows the server's
   * state again.
   */
  async markRead(chatId: string, upTo: string | undefined) {
    const chat = this.chats.get(chatId)
    if (chat?.unread) this.setChat({ ...chat, unread: false })
    try {
      await api().chats.read({ chatId, upTo })
    } catch (error) {
      await this.#refetchChats().catch(() => {}) // The save's error is the one to show.
      throw error
    }
  }

  /** Chat ids pinned in the sidebar, in the owner's order. */
  get pinnedChatIds(): string[] {
    return [...this.chats.values()]
      .filter((chat) => chat.pinnedPosition !== null)
      .sort((a, b) => a.pinnedPosition! - b.pinnedPosition!)
      .map((chat) => chat.id)
  }

  /** Pin saves in flight, sent one after another so they land in the order the owner made them. */
  #pinning: Promise<unknown> = Promise.resolve()

  /**
   * Pins exactly `chatIds`, in that order: shown at once, then saved; the saved order arrives as `chat.updated`
   * events. A failed save shows the server's order again.
   */
  async setPinned(chatIds: string[]) {
    this.#update(() => {
      const chats = new Map(this.chats)
      for (const [id, chat] of chats) {
        const position = chatIds.indexOf(id)
        chats.set(id, { ...chat, pinnedPosition: position === -1 ? null : position })
      }
      this.chats = chats
    })
    const save = this.#pinning.then(() => api().chats.setPinned({ chatIds }))
    this.#pinning = save.catch(() => {})
    try {
      await save
    } catch (error) {
      await this.#refetchChats().catch(() => {}) // The save's error is the one to show.
      throw error
    }
  }

  async #refetchChats() {
    this.#setChats(await api().chats.list())
  }

  #setChats(chats: readonly ChatInfo[]) {
    this.#update(() => (this.chats = new Map(chats.map((chat) => [chat.id, chat]))))
  }

  #setSections(sections: readonly SectionInfo[]) {
    this.#update(() => (this.sections = sections))
  }

  /** Adds a section at the top of the sidebar. */
  async createSection(name: string): Promise<SectionInfo> {
    const section = await api().sections.create({ name })
    this.#setSections([section, ...this.sections.filter((entry) => entry.id !== section.id)])
    return section
  }

  async renameSection(sectionId: string, name: string) {
    const section = await api().sections.rename({ sectionId, name })
    this.#setSections(this.sections.map((entry) => (entry.id === section.id ? section : entry)))
  }

  /** Puts every section, Unassigned included, in the order of `sectionIds`: shown at once, then saved. */
  async reorderSections(sectionIds: string[]) {
    const byId = new Map(this.sections.map((section) => [section.id, section]))
    this.#setSections(sectionIds.flatMap((id) => byId.get(id) ?? []))
    try {
      this.#setSections(await api().sections.reorder({ sectionIds }))
    } catch (error) {
      this.#setSections(await api().sections.list().catch(() => [...byId.values()]))
      throw error
    }
  }

  /** Deletes a section; its chats go to Unassigned. */
  async deleteSection(sectionId: string) {
    await api().sections.delete({ sectionId })
    this.#setSections(this.sections.filter((section) => section.id !== sectionId))
    this.#setChats([...this.chats.values()].map((chat) => (chat.sectionId === sectionId ? { ...chat, sectionId: unassignedSectionId } : chat)))
  }

  /** Moves chats to a section (Unassigned for none), showing any hidden ones. */
  async moveChats(chatIds: string[], sectionId: string) {
    this.#setChats(await api().chats.move({ chatIds, sectionId }))
  }

  /** Hides chats: they go to the sidebar's Hidden section, unpinned. */
  async hideChats(chatIds: string[]) {
    this.#setChats(await api().chats.hide({ chatIds }))
  }

  /** Shows hidden chats again, each back in its section. */
  async showChats(chatIds: string[]) {
    this.#setChats(await api().chats.show({ chatIds }))
  }

  setDraft(chatId: string, text: string) {
    this.#update(() => {
      const drafts = new Map(this.drafts)
      if (text) drafts.set(chatId, text)
      else drafts.delete(chatId)
      this.drafts = drafts
    })
    try {
      if (text) this.#storage?.setItem(draftKeyPrefix + chatId, text)
      else this.#storage?.removeItem(draftKeyPrefix + chatId)
    } catch {
      // Storage blocked or full: the draft lasts until reload.
    }
  }

  addBot(bot: BotInfo) {
    this.#update(() => (this.bots = [...(this.bots ?? []).filter((entry) => entry.id !== bot.id), bot]))
  }

  /** Shows a bot as it is now, e.g. after the owner edited its profile. */
  updateBot(bot: BotInfo) {
    this.#update(() => (this.bots = this.bots?.map((entry) => (entry.id === bot.id ? bot : entry))))
  }

  /** Forgets a deleted bot and its DM; its messages in other chats now show it as deleted. */
  removeBot(botId: string, chatId: string) {
    this.#update(() => {
      this.bots = this.bots?.filter((bot) => bot.id !== botId)
      const chats = new Map(this.chats)
      chats.delete(chatId)
      this.chats = chats
      const messages = new Map(this.messages)
      messages.delete(chatId)
      this.#older.delete(chatId)
      for (const [id, list] of messages) {
        if (!list.some((message) => message.botId === botId)) continue
        messages.set(
          id,
          list.map((message) => (message.botId === botId ? { ...message, botId: null, authorName: deletedAuthorName(message.authorName) } : message)),
        )
      }
      this.messages = messages
    })
    this.setDraft(chatId, '')
  }

  /** Forgets a deleted group chat, its messages and any draft. */
  removeChat(chatId: string) {
    this.#update(() => {
      const chats = new Map(this.chats)
      chats.delete(chatId)
      this.chats = chats
      const messages = new Map(this.messages)
      messages.delete(chatId)
      this.#older.delete(chatId)
      this.messages = messages
    })
    this.setDraft(chatId, '')
  }

  async #apply({ epoch, seq, event }: StampedEvent) {
    const stamp = this.#stamp
    if (event.type !== 'hello' && stamp?.epoch === epoch && seq <= stamp.seq) return // already applied
    // Taken only after a refetch succeeds: if it fails, the next connection refetches again instead of resuming.
    if (event.type === 'hello' && !event.resumed) await this.#refetch()
    this.#stamp = { epoch, seq }
    this.#handle(event)
    for (const listener of this.#eventListeners) listener(event)
  }

  #handle(event: LiveEvent) {
    switch (event.type) {
      case 'hello':
        this.#update(() => (this.connected = true))
        return
      case 'bot.created':
        return this.addBot(event.bot)
      case 'bot.updated':
        return this.updateBot(event.bot)
      case 'bot.deleted':
        return this.removeBot(event.botId, event.chatId)
      case 'bot.status':
        return this.#update(() => {
          this.bots = this.bots?.map((bot) => (bot.id === event.botId ? { ...bot, working: event.working, error: event.error } : bot))
        })
      case 'message.created':
        // Chats not opened yet load their latest messages when they are.
        if (this.messages.has(event.message.chatId)) this.addMessage(event.message)
        return
      case 'message.updated':
        if (this.messages.has(event.message.chatId)) this.addMessage(event.message)
        return
      case 'chat.updated':
        return this.setChat(event.chat)
      case 'chat.deleted':
        return this.removeChat(event.chatId)
      case 'sections.updated':
        return this.#setSections(event.sections)
    }
  }

  async #refetch() {
    const [bots, summaries, sections, chats] = await Promise.all([
      api().bots.list(),
      api().chats.list(),
      api().sections.list(),
      // Each opened chat's latest page: older pages loaded before are kept when it joins up with them.
      Promise.all([...this.messages.keys()].map(async (chatId) => [chatId, await api().chats.messages({ chatId })] as const)),
    ])
    this.#update(() => {
      this.bots = bots
      this.chats = new Map(summaries.map((chat) => [chat.id, chat]))
      this.sections = sections
      for (const [chatId, page] of chats) this.#mergeLatest(chatId, page)
    })
  }

  #mergeLatest(chatId: string, page: MessagesPage) {
    const merged = mergeLatest(this.messages.get(chatId) ?? [], this.#older.get(chatId), page)
    this.#older.set(chatId, merged.older)
    this.#setMessages(chatId, merged.messages)
  }

  #setMessages(chatId: string, messages: MessageInfo[]) {
    this.messages = new Map(this.messages).set(chatId, messages)
  }

  #update(change: () => void) {
    change()
    this.#version++
    for (const listener of this.#listeners) listener()
  }
}

const LiveContext = createContext<LiveStore | undefined>(undefined)

export function LiveProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new LiveStore())
  useEffect(() => {
    const controller = new AbortController()
    void store.run(controller.signal)
    return () => controller.abort()
  }, [store])
  return <LiveContext.Provider value={store}>{children}</LiveContext.Provider>
}

/** Calls the latest `listener` with every live event, as `LiveStore.listen`, while the component is mounted. */
export function useLiveEvents(listener: (event: LiveEvent) => void) {
  const store = useContext(LiveContext)
  if (!store) throw new Error('useLiveEvents needs a LiveProvider')
  const latest = useRef(listener)
  latest.current = listener
  useEffect(() => store.listen((event) => latest.current(event)), [store])
}

/** The live store, re-rendering on every change. */
export function useLive(): LiveStore {
  const store = useContext(LiveContext)
  if (!store) throw new Error('useLive needs a LiveProvider')
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return store
}
