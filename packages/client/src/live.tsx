import {
  type ApiClient,
  type BotInfo,
  type ChatInfo,
  defaultMessagesPageSize,
  deletedAuthorName,
  type LiveEvent,
  maxMessagesPageSize,
  type MessageInfo,
  type MessagesPage,
  type SectionInfo,
  type StampedEvent,
  unassignedSectionId,
} from '@openbot/api-contract'
import { type ReactNode, createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'

const reconnectDelayMs = 1000
const draftKeyPrefix = 'openbot.draft.'
/** How long after a change the snapshot is saved, so a burst of changes is saved once. */
const snapshotDelayMs = 1000
/** The most chats whose messages the snapshot keeps: those with the newest messages. */
const snapshotChats = 20

/**
 * Synchronous key–value storage for drafts: `localStorage` on the web, `expo-sqlite/kv-store` on the phone. Any call
 * may throw, e.g. in a private window; drafts then last while the app is open.
 */
export type KeyValueStorage = {
  keys(): string[]
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** What the store keeps of the instance between starts, to show while offline. */
export type LiveSnapshot = {
  /** Raised when the shape changes; a snapshot of another version is ignored. */
  version: typeof snapshotVersion
  bots: BotInfo[]
  chats: ChatInfo[]
  sections: SectionInfo[]
  /** The latest messages of the chats with the newest, oldest first, and the cursor of the page before them. */
  messages: { chatId: string; messages: MessageInfo[]; older: string | null }[]
}

const snapshotVersion = 1

/** Where the snapshot is kept; the phone keeps it on disk, the web keeps none. */
export type SnapshotStore = {
  load(): LiveSnapshot | undefined | Promise<LiveSnapshot | undefined>
  save(snapshot: LiveSnapshot): void | Promise<void>
}

export type LiveStoreOptions = {
  api: ApiClient
  /** Where drafts are kept. */
  storage: KeyValueStorage
  /** Saves chats and loaded messages after changes and restores them at startup, to show them offline. */
  snapshot?: SnapshotStore
}

/** The drafts kept in `storage`, by chat id; none if storage is blocked. */
function loadDrafts(storage: KeyValueStorage): Map<string, string> {
  const drafts = new Map<string, string>()
  try {
    for (const key of storage.keys()) {
      if (!key.startsWith(draftKeyPrefix)) continue
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
 * With a `snapshot`, what was last seen shows at startup until the server is reached.
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
  /** What the owner has typed but not sent, per chat; kept in `storage`, or while the app is open if it's blocked. */
  drafts: ReadonlyMap<string, string>
  connected = false
  #stamp: { epoch: string; seq: number } | undefined
  #listeners = new Set<() => void>()
  #eventListeners = new Set<(event: LiveEvent) => void>()
  #version = 0
  readonly #api: ApiClient
  readonly #storage: KeyValueStorage
  readonly #snapshot: SnapshotStore | undefined
  /** Settles once the snapshot is restored (or there is none). */
  readonly #restored: Promise<void>
  #saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor({ api, storage, snapshot }: LiveStoreOptions) {
    this.#api = api
    this.#storage = storage
    this.#snapshot = snapshot
    this.drafts = loadDrafts(storage)
    this.#restored = this.#restore()
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
    // Restored first, so a snapshot never covers what the server sent.
    await this.#restored
    while (!signal.aborted) {
      try {
        const events = await this.#api.events(this.#stamp, { signal })
        for await (const event of events) await this.#apply(event)
      } catch {
        // Disconnected; reconnect below.
      }
      if (this.connected) this.#update(() => (this.connected = false))
      if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs))
    }
  }

  /** Loads a chat's latest messages, merging them with any that arrived live meanwhile. */
  async openChat(chatId: string) {
    // Registered first, so messages that arrive live while loading are kept.
    if (!this.messages.has(chatId)) this.#update(() => this.#setMessages(chatId, []))
    const page = await this.#api.chats.messages({ chatId })
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
        page = await this.#api.chats.messages({ chatId, cursor, limit })
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
      await this.#api.chats.read({ chatId, upTo })
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
    const save = this.#pinning.then(() => this.#api.chats.setPinned({ chatIds }))
    this.#pinning = save.catch(() => {})
    try {
      await save
    } catch (error) {
      await this.#refetchChats().catch(() => {}) // The save's error is the one to show.
      throw error
    }
  }

  async #refetchChats() {
    this.#setChats(await this.#api.chats.list())
  }

  #setChats(chats: readonly ChatInfo[]) {
    this.#update(() => (this.chats = new Map(chats.map((chat) => [chat.id, chat]))))
  }

  #setSections(sections: readonly SectionInfo[]) {
    this.#update(() => (this.sections = sections))
  }

  /** Adds a section at the top of the sidebar. */
  async createSection(name: string): Promise<SectionInfo> {
    const section = await this.#api.sections.create({ name })
    this.#setSections([section, ...this.sections.filter((entry) => entry.id !== section.id)])
    return section
  }

  async renameSection(sectionId: string, name: string) {
    const section = await this.#api.sections.rename({ sectionId, name })
    this.#setSections(this.sections.map((entry) => (entry.id === section.id ? section : entry)))
  }

  /** Puts every section, Unassigned included, in the order of `sectionIds`: shown at once, then saved. */
  async reorderSections(sectionIds: string[]) {
    const byId = new Map(this.sections.map((section) => [section.id, section]))
    this.#setSections(sectionIds.flatMap((id) => byId.get(id) ?? []))
    try {
      this.#setSections(await this.#api.sections.reorder({ sectionIds }))
    } catch (error) {
      this.#setSections(await this.#api.sections.list().catch(() => [...byId.values()]))
      throw error
    }
  }

  /** Deletes a section; its chats go to Unassigned. */
  async deleteSection(sectionId: string) {
    await this.#api.sections.delete({ sectionId })
    this.#setSections(this.sections.filter((section) => section.id !== sectionId))
    this.#setChats([...this.chats.values()].map((chat) => (chat.sectionId === sectionId ? { ...chat, sectionId: unassignedSectionId } : chat)))
  }

  /** Moves chats to a section (Unassigned for none), showing any hidden ones. */
  async moveChats(chatIds: string[], sectionId: string) {
    this.#setChats(await this.#api.chats.move({ chatIds, sectionId }))
  }

  /** Hides chats: they go to the sidebar's Hidden section, unpinned. */
  async hideChats(chatIds: string[]) {
    this.#setChats(await this.#api.chats.hide({ chatIds }))
  }

  /** Shows hidden chats again, each back in its section. */
  async showChats(chatIds: string[]) {
    this.#setChats(await this.#api.chats.show({ chatIds }))
  }

  setDraft(chatId: string, text: string) {
    this.#update(() => {
      const drafts = new Map(this.drafts)
      if (text) drafts.set(chatId, text)
      else drafts.delete(chatId)
      this.drafts = drafts
    }, { snapshot: false }) // Drafts are kept in storage, not in the snapshot.
    try {
      if (text) this.#storage.setItem(draftKeyPrefix + chatId, text)
      else this.#storage.removeItem(draftKeyPrefix + chatId)
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
    const [bots, summaries, sections] = await Promise.all([this.#api.bots.list(), this.#api.chats.list(), this.#api.sections.list()])
    // Each opened chat's latest page, of those not deleted meanwhile: older pages loaded before are kept when it joins up with them.
    const existing = new Set(summaries.map((chat) => chat.id))
    const opened = [...this.messages.keys()].filter((chatId) => existing.has(chatId))
    const pages = await Promise.all(opened.map(async (chatId) => [chatId, await this.#api.chats.messages({ chatId })] as const))
    this.#update(() => {
      this.bots = bots
      this.chats = new Map(summaries.map((chat) => [chat.id, chat]))
      this.sections = sections
      const messages = new Map(this.messages)
      for (const chatId of messages.keys()) {
        if (existing.has(chatId)) continue
        messages.delete(chatId)
        this.#older.delete(chatId)
      }
      this.messages = messages
      for (const [chatId, page] of pages) this.#mergeLatest(chatId, page)
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

  /** Applies `change` and tells listeners; the snapshot is saved shortly after, unless the change isn't kept in it. */
  #update(change: () => void, { snapshot = true } = {}) {
    change()
    this.#version++
    for (const listener of this.#listeners) listener()
    if (snapshot && this.#snapshot) this.#saveTimer ??= setTimeout(() => this.saveSnapshot(), snapshotDelayMs)
  }

  /** Shows the snapshot's state. A snapshot that can't be read is ignored. */
  async #restore() {
    let snapshot: LiveSnapshot | undefined
    try {
      snapshot = await this.#snapshot?.load()
    } catch {
      return
    }
    // Not over the server's state, should it have arrived meanwhile.
    if (snapshot?.version !== snapshotVersion || this.#stamp) return
    this.#update(() => {
      this.bots = snapshot.bots
      this.chats = new Map(snapshot.chats.map((chat) => [chat.id, chat]))
      this.sections = snapshot.sections
      for (const { chatId, messages, older } of snapshot.messages) {
        if (this.messages.has(chatId)) continue // opened meanwhile
        this.#older.set(chatId, older)
        this.#setMessages(chatId, messages)
      }
    })
  }

  /**
   * Saves the snapshot now, e.g. as the app goes to the background; it is also saved shortly after every change. Of
   * the chats with the newest messages, it keeps the latest page of each.
   */
  saveSnapshot() {
    clearTimeout(this.#saveTimer)
    this.#saveTimer = undefined
    if (!this.#snapshot || !this.bots) return
    const newest = (messages: readonly MessageInfo[]) => messages.at(-1)?.id ?? ''
    const messages = [...this.messages]
      // Not those still loading their latest page, whose older messages aren't known.
      .filter(([chatId, list]) => list.length && this.#older.has(chatId))
      .sort(([, a], [, b]) => (newest(a) < newest(b) ? 1 : newest(a) > newest(b) ? -1 : 0))
      .slice(0, snapshotChats)
      .map(([chatId, list]) => {
        const kept = list.slice(-defaultMessagesPageSize)
        // A page's cursor is its oldest message's id.
        return { chatId, messages: kept, older: kept.length < list.length ? kept[0]!.id : (this.#older.get(chatId) ?? null) }
      })
    const snapshot: LiveSnapshot = { version: snapshotVersion, bots: this.bots, chats: [...this.chats.values()], sections: [...this.sections], messages }
    void Promise.resolve()
      .then(() => this.#snapshot?.save(snapshot))
      .catch(() => {}) // Not saved: the next change tries again.
  }
}

const LiveContext = createContext<LiveStore | undefined>(undefined)

/** Provides `store` to the hooks below, following the server's live events while mounted. */
export function LiveProvider({ store, children }: { store: LiveStore; children: ReactNode }) {
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
