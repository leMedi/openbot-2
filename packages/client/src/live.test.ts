import { type ApiClient, type BotInfo, type ChatInfo, type LiveEvent, type MessageInfo, type SectionInfo, unassignedSectionId, viewingHeartbeatInterval } from '@openbot/api-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type KeyValueStorage, type LiveSnapshot, LiveStore, type SnapshotStore } from './live.tsx'

/** Key–value storage in memory, as localStorage or the phone's kv-store. */
function memoryStorage(): KeyValueStorage {
  const items = new Map<string, string>()
  return {
    keys: () => [...items.keys()],
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

/** Storage as in a private window or with site data blocked: every access throws. */
function blockedStorage(): KeyValueStorage {
  const blocked = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  return { keys: blocked, getItem: blocked, setItem: blocked, removeItem: blocked }
}

/** A snapshot kept in memory, as the phone keeps one on disk. */
function memorySnapshot(saved?: LiveSnapshot): SnapshotStore & { saved: LiveSnapshot | undefined } {
  return {
    saved,
    load() {
      return this.saved
    },
    save(snapshot) {
      this.saved = structuredClone(snapshot)
    },
  }
}

const bot = (id: string): BotInfo => ({
  id,
  name: `Bot ${id}`,
  title: null,
  instructions: '',
  avatarStyle: 'critter',
  avatarShape: 'blob',
  avatarColor: 'blue',
  model: null,
  chatId: `dm-${id}`,
  working: false,
  error: null,
})

const chat = (id: string, changes: Partial<ChatInfo> = {}): ChatInfo => ({
  id,
  kind: 'dm',
  botId: null,
  name: null,
  title: null,
  members: [],
  speaking: null,
  pinnedPosition: null,
  sectionId: unassignedSectionId,
  hidden: false,
  mutedUntil: null,
  unread: false,
  waitingFor: null,
  lastMessage: null,
  ...changes,
})

const message = (id: string, chatId: string, text = id): MessageInfo => ({
  id,
  chatId,
  author: 'owner',
  botId: null,
  authorName: 'You',
  text,
  attachments: [],
  card: null,
  botMessage: null,
  createdAt: 0,
})

const hello = (epoch: string, seq: number, resumed: boolean) => ({ epoch, seq, event: { type: 'hello', resumed } as LiveEvent })

/**
 * The instance as the store sees it through the API. Each connection to the event stream takes the next of
 * `connections`: its events, then it stays open until `drop()`; with none left, the instance can't be reached.
 */
function fakeServer() {
  const server = {
    bots: [] as BotInfo[],
    chats: [] as ChatInfo[],
    sections: [{ id: unassignedSectionId, name: null }] as SectionInfo[],
    messages: new Map<string, MessageInfo[]>(),
    connections: [] as { epoch: string; seq: number; event: LiveEvent }[][],
    /** The stamp each connection resumed from. */
    stamps: [] as ({ epoch: string; seq: number } | undefined)[],
    /** How many times the store read everything anew. */
    refetches: 0,
    /** The chats each viewing heartbeat named, in order; a heartbeat fails while `unreachable`. */
    viewing: [] as string[],
    unreachable: false,
    /** Connections to the event stream get no answer, as from an instance gone silent, until given up. */
    silent: false,
    drop: () => {},
  }
  const api = {
    events: async (stamp: { epoch: string; seq: number } | undefined, { signal }: { signal: AbortSignal }) => {
      server.stamps.push(stamp)
      if (server.silent) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve))
        throw new DOMException('Aborted', 'AbortError')
      }
      const events = server.connections.shift()
      if (!events) throw new TypeError('Failed to fetch')
      const dropped = new Promise<void>((resolve) => {
        server.drop = resolve
        signal.addEventListener('abort', () => resolve())
      })
      return (async function* () {
        yield* events
        await dropped
      })()
    },
    bots: {
      list: async () => {
        server.refetches++
        return server.bots
      },
    },
    chats: {
      list: async () => server.chats,
      unread: async ({ chatId }: { chatId: string }) => {
        if (server.unreachable) throw new TypeError('Failed to fetch')
        const marked = { ...server.chats.find((entry) => entry.id === chatId)!, unread: true }
        server.chats = server.chats.map((entry) => (entry.id === chatId ? marked : entry))
        return marked
      },
      viewing: async ({ chatId }: { chatId: string }) => {
        if (server.unreachable) throw new TypeError('Failed to fetch')
        server.viewing.push(chatId)
      },
      messages: async ({ chatId }: { chatId: string }) => {
        if (server.unreachable) throw new TypeError('Failed to fetch')
        if (!server.chats.some((entry) => entry.id === chatId)) throw new Error('Chat not found')
        return { messages: [...(server.messages.get(chatId) ?? [])].reverse(), nextCursor: null }
      },
    },
    sections: { list: async () => server.sections },
  }
  return { server, api: api as unknown as ApiClient }
}

describe('drafts', () => {
  const { api } = fakeServer()

  it('survive a reload', () => {
    const storage = memoryStorage()
    new LiveStore({ api, storage }).setDraft('chat-1', 'half a thought')

    expect(new LiveStore({ api, storage }).drafts.get('chat-1')).toBe('half a thought')
  })

  it('are gone after a reload once sent', () => {
    const storage = memoryStorage()
    const store = new LiveStore({ api, storage })
    store.setDraft('chat-1', 'half a thought')
    store.setDraft('chat-1', '')

    expect(new LiveStore({ api, storage }).drafts.has('chat-1')).toBe(false)
  })

  it('of a deleted chat are gone after a reload', () => {
    const storage = memoryStorage()
    const store = new LiveStore({ api, storage })
    store.setDraft('group-1', 'to the group')
    store.setDraft('dm-1', 'to the bot')
    store.removeChat('group-1')
    store.removeBot('bot-1', 'dm-1')

    expect(new LiveStore({ api, storage }).drafts.size).toBe(0)
  })

  it('are kept in memory when storage is blocked', () => {
    const store = new LiveStore({ api, storage: blockedStorage() })
    store.setDraft('chat-1', 'half a thought')
    expect(store.drafts.get('chat-1')).toBe('half a thought')

    store.setDraft('chat-1', '')
    store.removeChat('chat-1')
    expect(store.drafts.has('chat-1')).toBe(false)
  })
})

describe('the live stream', () => {
  let controller: AbortController
  beforeEach(() => {
    vi.useFakeTimers()
    controller = new AbortController()
  })
  afterEach(() => {
    controller.abort()
    vi.useRealTimers()
  })

  it('resumes from the last stamp after a gap the instance can fill, without reading everything anew', async () => {
    const { server, api } = fakeServer()
    server.bots = [bot('rex')]
    server.connections = [
      [hello('e1', 4, false), { epoch: 'e1', seq: 5, event: { type: 'bot.created', bot: bot('ana') } }],
      [hello('e1', 5, true), { epoch: 'e1', seq: 6, event: { type: 'bot.status', botId: 'ana', working: true, error: null } }],
    ]
    const store = new LiveStore({ api, storage: memoryStorage() })
    void store.run(controller.signal)
    await vi.waitFor(() => expect(store.bots?.map((entry) => entry.id)).toEqual(['rex', 'ana']))

    server.drop()
    await vi.waitFor(() => expect(store.bots?.find((entry) => entry.id === 'ana')?.working).toBe(true), { timeout: 5000 })
    expect(server.stamps).toEqual([undefined, { epoch: 'e1', seq: 5 }])
    expect(server.refetches).toBe(1)
    expect(store.connected).toBe(true)
  })

  it('closed and run again, as the phone does in the background, resumes from the last stamp', async () => {
    const { server, api } = fakeServer()
    server.bots = [bot('rex')]
    server.connections = [
      [hello('e1', 4, false), { epoch: 'e1', seq: 5, event: { type: 'bot.created', bot: bot('ana') } }],
      [hello('e1', 5, true), { epoch: 'e1', seq: 6, event: { type: 'bot.status', botId: 'ana', working: true, error: null } }],
    ]
    const store = new LiveStore({ api, storage: memoryStorage() })
    const background = new AbortController()
    const closed = store.run(background.signal)
    await vi.waitFor(() => expect(store.bots?.map((entry) => entry.id)).toEqual(['rex', 'ana']))

    background.abort()
    await closed
    expect(store.connected).toBe(false)
    expect(server.stamps).toHaveLength(1)

    void store.run(controller.signal)
    await vi.waitFor(() => expect(store.bots?.find((entry) => entry.id === 'ana')?.working).toBe(true))
    expect(server.stamps).toEqual([undefined, { epoch: 'e1', seq: 5 }])
    expect(server.refetches).toBe(1)
  })

  it('reads everything anew when the gap is too old to resume', async () => {
    const { server, api } = fakeServer()
    server.bots = [bot('rex')]
    server.chats = [chat('dm-rex', { botId: 'rex' })]
    server.messages.set('dm-rex', [message('m1', 'dm-rex')])
    server.connections = [[hello('e1', 4, false)], [hello('e1', 2000, false)]]
    const store = new LiveStore({ api, storage: memoryStorage() })
    void store.run(controller.signal)
    await vi.waitFor(() => expect(store.connected).toBe(true))
    await store.openChat('dm-rex')

    server.bots = [bot('rex'), bot('ana')]
    server.messages.set('dm-rex', [message('m1', 'dm-rex'), message('m2', 'dm-rex')])
    server.drop()
    await vi.waitFor(() => expect(store.bots?.map((entry) => entry.id)).toEqual(['rex', 'ana']), { timeout: 5000 })
    expect(store.messages.get('dm-rex')?.map((entry) => entry.id)).toEqual(['m1', 'm2'])
    expect(server.stamps).toEqual([undefined, { epoch: 'e1', seq: 4 }])
    expect(server.refetches).toBe(2)
  })
  it('tries again at once when asked, not waiting for the next attempt, and gives up on one with no answer', async () => {
    const { server, api } = fakeServer()
    const store = new LiveStore({ api, storage: memoryStorage() })
    void store.run(controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(server.stamps).toHaveLength(1)

    server.silent = true
    store.retryNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.stamps).toHaveLength(2)

    server.silent = false
    server.connections = [[hello('e1', 1, false)]]
    store.retryNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.stamps).toHaveLength(3)
    expect(store.connected).toBe(true)

    store.retryNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.stamps).toHaveLength(3)
    expect(store.connected).toBe(true)
  })
  it('reopens the stream at once when the network changes, resuming from its stamp, even while connected', async () => {
    const { server, api } = fakeServer()
    server.connections = [[hello('e1', 1, false)], [hello('e1', 1, true)]]
    const store = new LiveStore({ api, storage: memoryStorage() })
    void store.run(controller.signal)
    await vi.waitFor(() => expect(store.connected).toBe(true))

    store.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.stamps).toEqual([undefined, { epoch: 'e1', seq: 1 }])
    expect(store.connected).toBe(true)
    expect(server.refetches).toBe(1)
  })

  it("loads a chat opened while the instance couldn't be reached once the stream resumes", async () => {
    const { server, api } = fakeServer()
    server.chats = [chat('dm-rex')]
    server.messages.set('dm-rex', [message('m1', 'dm-rex')])
    server.connections = [[hello('e1', 1, false)]]
    const store = new LiveStore({ api, storage: memoryStorage() })
    void store.run(controller.signal)
    await vi.waitFor(() => expect(store.connected).toBe(true))

    server.unreachable = true
    server.drop()
    await vi.advanceTimersByTimeAsync(0)
    await expect(store.openChat('dm-rex')).rejects.toThrow()
    expect(store.messages.get('dm-rex')).toEqual([])

    server.unreachable = false
    server.connections = [[hello('e1', 1, true)]]
    store.retryNow()
    await vi.waitFor(() => expect(store.messages.get('dm-rex')?.map((entry) => entry.id)).toEqual(['m1']))
    expect(server.refetches).toBe(1)
  })
})

describe('the snapshot', () => {
  let controller: AbortController
  beforeEach(() => {
    vi.useFakeTimers()
    controller = new AbortController()
  })
  afterEach(() => {
    controller.abort()
    vi.useRealTimers()
  })

  it('keeps chats and loaded messages for the next start', async () => {
    const { server, api } = fakeServer()
    server.bots = [bot('rex')]
    server.chats = [chat('dm-rex', { botId: 'rex' })]
    server.messages.set('dm-rex', [message('m1', 'dm-rex'), message('m2', 'dm-rex')])
    server.connections = [[hello('e1', 1, false)]]
    const snapshot = memorySnapshot()
    const store = new LiveStore({ api, storage: memoryStorage(), snapshot })
    void store.run(controller.signal)
    await vi.waitFor(() => expect(store.connected).toBe(true))
    await store.openChat('dm-rex')
    await vi.waitFor(() => expect(snapshot.saved?.messages).toHaveLength(1))
    controller.abort()

    const { api: offline } = fakeServer()
    const restarted = new LiveStore({ api: offline, storage: memoryStorage(), snapshot })
    void restarted.run(new AbortController().signal)
    await vi.waitFor(() => expect(restarted.messages.get('dm-rex')?.map((entry) => entry.text)).toEqual(['m1', 'm2']))
    expect(restarted.bots?.map((entry) => entry.id)).toEqual(['rex'])
    expect(restarted.chats.get('dm-rex')?.botId).toBe('rex')
  })

  it('shows what it kept while offline, then what the instance has once it connects', async () => {
    const { server, api } = fakeServer()
    const snapshot = memorySnapshot({
      version: 2,
      bots: [bot('rex'), bot('gone')],
      chats: [chat('dm-rex', { botId: 'rex' }), chat('dm-gone', { botId: 'gone' })],
      sections: [{ id: unassignedSectionId, name: null }],
      messages: [
        { chatId: 'dm-rex', messages: [message('m1', 'dm-rex', 'kept')], older: null },
        { chatId: 'dm-gone', messages: [message('m0', 'dm-gone')], older: null },
      ],
    })
    const store = new LiveStore({ api, storage: memoryStorage(), snapshot })
    void store.run(controller.signal)
    await vi.waitFor(() => expect(store.messages.get('dm-rex')?.map((entry) => entry.text)).toEqual(['kept']))
    expect(store.bots?.map((entry) => entry.id)).toEqual(['rex', 'gone'])
    expect(store.connected).toBe(false)

    server.bots = [bot('rex')]
    server.chats = [chat('dm-rex', { botId: 'rex', unread: true })]
    server.messages.set('dm-rex', [message('m1', 'dm-rex', 'edited'), message('m2', 'dm-rex', 'new')])
    server.connections = [[hello('e1', 9, false)]]
    await vi.waitFor(() => expect(store.connected).toBe(true), { timeout: 5000 })
    expect(store.bots?.map((entry) => entry.id)).toEqual(['rex'])
    expect([...store.chats.keys()]).toEqual(['dm-rex'])
    expect(store.chats.get('dm-rex')?.unread).toBe(true)
    expect(store.messages.get('dm-rex')?.map((entry) => entry.text)).toEqual(['edited', 'new'])
    expect(store.messages.has('dm-gone')).toBe(false)
  })

  it("isn't saved again as the owner types a draft", async () => {
    const { server, api } = fakeServer()
    server.bots = [bot('rex')]
    server.connections = [[hello('e1', 1, false)]]
    const snapshot = memorySnapshot()
    const save = vi.spyOn(snapshot, 'save')
    const store = new LiveStore({ api, storage: memoryStorage(), snapshot })
    void store.run(controller.signal)
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 5000 })

    store.setDraft('dm-rex', 'half a thought')
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('from an older version of the app is ignored', async () => {
    const { api } = fakeServer()
    const snapshot = memorySnapshot({ version: 0, bots: [bot('rex')], chats: [], sections: [], messages: [] } as unknown as LiveSnapshot)
    const store = new LiveStore({ api, storage: memoryStorage(), snapshot })
    void store.run(controller.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(store.bots).toBeUndefined()
  })
})

describe('marking a chat unread', () => {
  async function connectedStore() {
    const { server, api } = fakeServer()
    server.chats = [chat('dm-1')]
    server.connections.push([hello('e1', 1, false)])
    const store = new LiveStore({ api, storage: memoryStorage() })
    const controller = new AbortController()
    void store.run(controller.signal)
    await vi.waitFor(() => expect(store.connected).toBe(true))
    return { server, store, stop: () => controller.abort() }
  }

  it('shows it unread as the instance has it then', async () => {
    const { store, stop } = await connectedStore()
    await store.markUnread('dm-1')
    expect(store.chats.get('dm-1')?.unread).toBe(true)
    stop()
  })

  it('leaves it as it was when the save fails', async () => {
    const { server, store, stop } = await connectedStore()
    server.unreachable = true
    await expect(store.markUnread('dm-1')).rejects.toThrow('Failed to fetch')
    expect(store.chats.get('dm-1')?.unread).toBe(false)
    stop()
  })
})

describe('the viewing heartbeat', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says the owner is viewing the chat at once, then every 30 s until stopped', async () => {
    const { server, api } = fakeServer()
    const store = new LiveStore({ api, storage: memoryStorage() })

    const stop = store.viewChat('dm-rex')
    await vi.advanceTimersByTimeAsync(0)
    expect(server.viewing).toEqual(['dm-rex'])
    await vi.advanceTimersByTimeAsync(viewingHeartbeatInterval - 1)
    expect(server.viewing).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1 + viewingHeartbeatInterval)
    expect(server.viewing).toEqual(['dm-rex', 'dm-rex', 'dm-rex'])

    stop()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(server.viewing).toHaveLength(3)
  })

  it('keeps beating after a heartbeat fails, as the instance comes back', async () => {
    const { server, api } = fakeServer()
    const store = new LiveStore({ api, storage: memoryStorage() })
    server.unreachable = true

    const stop = store.viewChat('dm-rex')
    await vi.advanceTimersByTimeAsync(0)
    server.unreachable = false
    await vi.advanceTimersByTimeAsync(viewingHeartbeatInterval)
    expect(server.viewing).toEqual(['dm-rex'])
    stop()
  })

  it('waits for the heartbeat due when the chat comes back in front soon after, as the owner switches windows', async () => {
    const { server, api } = fakeServer()
    const store = new LiveStore({ api, storage: memoryStorage() })

    let stop = store.viewChat('dm-rex')
    await vi.advanceTimersByTimeAsync(10_000)
    stop()
    stop = store.viewChat('dm-rex')
    await vi.advanceTimersByTimeAsync(0)
    expect(server.viewing).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(viewingHeartbeatInterval - 10_000)
    expect(server.viewing).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(viewingHeartbeatInterval)
    expect(server.viewing).toHaveLength(3)
    stop()

    stop = store.viewChat('dm-ana')
    await vi.advanceTimersByTimeAsync(0)
    expect(server.viewing.at(-1)).toBe('dm-ana')
    stop()
  })
})
