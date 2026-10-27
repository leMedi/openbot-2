import { type BotInfo, type ChatInfo, deletedAuthorName, type MessageInfo, type StampedEvent } from '@openbot/api-contract'
import { type ReactNode, createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
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
 * Bots, every chat's sidebar state, and the messages of opened chats, kept in sync with the server over the live event stream. A reconnect
 * resumes from the last stamp seen; when the server can't resume (a restart, or too long away), everything is refetched.
 */
export class LiveStore {
  bots: BotInfo[] | undefined
  /** Every chat's sidebar state (pinned, unread, waiting), by chat id. */
  chats: ReadonlyMap<string, ChatInfo> = new Map()
  messages: ReadonlyMap<string, MessageInfo[]> = new Map()
  /** What the owner has typed but not sent, per chat; kept in this browser's storage, or while the app is open if it's blocked. */
  drafts: ReadonlyMap<string, string>
  connected = false
  #stamp: { epoch: string; seq: number } | undefined
  #listeners = new Set<() => void>()
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

  /** Loads a chat's messages, merging them with any that arrived live meanwhile. */
  async openChat(chatId: string) {
    // Registered first, so messages that arrive live while loading are kept.
    if (!this.messages.has(chatId)) this.#update(() => this.#setMessages(chatId, []))
    const loaded = await api().chats.messages({ chatId })
    this.#update(() => this.#setMessages(chatId, mergeMessages(this.messages.get(chatId) ?? [], loaded)))
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
    const chats = await api().chats.list()
    this.#update(() => (this.chats = new Map(chats.map((chat) => [chat.id, chat]))))
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
        // Chats not opened yet load everything when they are.
        if (this.messages.has(event.message.chatId)) this.addMessage(event.message)
        return
      case 'message.updated':
        if (this.messages.has(event.message.chatId)) this.addMessage(event.message)
        return
      case 'chat.updated':
        return this.setChat(event.chat)
      case 'chat.deleted':
        return this.removeChat(event.chatId)
    }
  }

  async #refetch() {
    const [bots, summaries, chats] = await Promise.all([
      api().bots.list(),
      api().chats.list(),
      Promise.all([...this.messages.keys()].map(async (chatId) => [chatId, await api().chats.messages({ chatId })] as const)),
    ])
    this.#update(() => {
      this.bots = bots
      this.chats = new Map(summaries.map((chat) => [chat.id, chat]))
      for (const [chatId, loaded] of chats) {
        this.#setMessages(chatId, mergeMessages(this.messages.get(chatId) ?? [], loaded))
      }
    })
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

/** The live store, re-rendering on every change. */
export function useLive(): LiveStore {
  const store = useContext(LiveContext)
  if (!store) throw new Error('useLive needs a LiveProvider')
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return store
}
