import { type BotInfo, deletedAuthorName, type MessageInfo, type StampedEvent } from '@openbot/api-contract'
import { type ReactNode, createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { api } from './api.ts'

const reconnectDelayMs = 1000

/** Merges `incoming` into `messages`, once each, oldest first (ids are time-ordered). */
function mergeMessages(messages: readonly MessageInfo[], incoming: readonly MessageInfo[]): MessageInfo[] {
  const byId = new Map(messages.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Bots and the messages of opened chats, kept in sync with the server over the live event stream. A reconnect
 * resumes from the last stamp seen; when the server can't resume (a restart, or too long away), everything is refetched.
 */
export class LiveStore {
  bots: BotInfo[] | undefined
  messages: ReadonlyMap<string, MessageInfo[]> = new Map()
  /** What the owner has typed but not sent, per chat; kept while the app is open. */
  drafts: ReadonlyMap<string, string> = new Map()
  connected = false
  #stamp: { epoch: string; seq: number } | undefined
  #listeners = new Set<() => void>()
  #version = 0

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

  setDraft(chatId: string, text: string) {
    this.#update(() => {
      const drafts = new Map(this.drafts)
      if (text) drafts.set(chatId, text)
      else drafts.delete(chatId)
      this.drafts = drafts
    })
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
      const drafts = new Map(this.drafts)
      drafts.delete(chatId)
      this.drafts = drafts
    })
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
    }
  }

  async #refetch() {
    const [bots, chats] = await Promise.all([
      api().bots.list(),
      Promise.all([...this.messages.keys()].map(async (chatId) => [chatId, await api().chats.messages({ chatId })] as const)),
    ])
    this.#update(() => {
      this.bots = bots
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
