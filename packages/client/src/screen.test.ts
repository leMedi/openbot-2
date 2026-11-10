import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Rfb, ScreenConnection, type ScreenConnectionOptions, type ScreenStatus } from './screen.ts'

/** noVNC's client as far as the connection uses it; the test says when it connects or drops. */
class FakeRfb extends EventTarget implements Rfb {
  viewOnly = false
  scaleViewport = false
  background = ''
  qualityLevel = 6
  compressionLevel = 2
  disconnected = false
  constructor(
    readonly target: HTMLElement,
    readonly url: string,
  ) {
    super()
  }
  focus() {}
  disconnect() {
    this.disconnected = true
    this.dispatchEvent(new Event('disconnect'))
  }
  connects() {
    this.dispatchEvent(new Event('connect'))
  }
  drops() {
    this.dispatchEvent(new Event('disconnect'))
  }
}

const target = {} as HTMLElement

function notRunning() {
  return Object.assign(new Error('The screen is starting'), { code: 'PRECONDITION_FAILED' })
}

function setup(options: Partial<ScreenConnectionOptions> = {}) {
  const clients: FakeRfb[] = []
  const tickets: string[] = []
  const ticketFailures: unknown[] = []
  const statuses: ScreenStatus[] = []
  const connection = new ScreenConnection(target, {
    botId: 'rex',
    server: 'http://openbot.local:3000/',
    ticket: async ({ botId }) => {
      const failure = ticketFailures.shift()
      if (failure) throw failure
      tickets.push(botId)
      return { url: `/api/screens/${botId}/stream?ticket=t${tickets.length}` }
    },
    openRfb: async (element, url) => {
      const client = new FakeRfb(element, url)
      clients.push(client)
      return client
    },
    onChange: () => statuses.push(connection.status),
    ...options,
  })
  return { connection, clients, tickets, ticketFailures, statuses, last: () => clients.at(-1)! }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ScreenConnection', () => {
  it('opens the stream with a ticket, over WebSocket on the instance, and is connected once noVNC is', async () => {
    const { connection, last } = setup()
    connection.start()
    expect(connection.status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(0)
    expect(last().url).toBe('ws://openbot.local:3000/api/screens/rex/stream?ticket=t1')
    expect(last().target).toBe(target)
    expect(last().viewOnly).toBe(true)
    expect(last().scaleViewport).toBe(true)
    last().connects()
    expect(connection.status).toBe('connected')
    expect(connection.rfb).toBe(last())
  })

  it('uses wss on an https instance', async () => {
    const { connection, last } = setup({ server: 'https://box.tail1234.ts.net' })
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(last().url).toBe('wss://box.tail1234.ts.net/api/screens/rex/stream?ticket=t1')
  })

  it('opens in control when interactive, and switches control without reconnecting', async () => {
    const { connection, clients, last } = setup({ interactive: true })
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(last().viewOnly).toBe(false)
    last().connects()
    connection.setInteractive(false)
    expect(last().viewOnly).toBe(true)
    connection.setInteractive(true)
    expect(last().viewOnly).toBe(false)
    expect(clients).toHaveLength(1)
  })

  it('streams at lower quality and higher compression on low, changeable while connected', async () => {
    const { connection, last } = setup({ quality: 'low' })
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(last().qualityLevel).toBeLessThan(6)
    expect(last().compressionLevel).toBeGreaterThan(2)
    connection.setQuality('high')
    expect(last().qualityLevel).toBe(6)
    expect(last().compressionLevel).toBe(2)
  })

  it('waits while the computer boots, without counting it as a failure', async () => {
    const { connection, ticketFailures, last, clients } = setup()
    ticketFailures.push(notRunning(), notRunning(), notRunning(), notRunning())
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.status).toBe('starting')
    await vi.advanceTimersByTimeAsync(4 * 1_500)
    expect(clients).toHaveLength(1)
    last().connects()
    expect(connection.status).toBe('connected')
  })

  it('reconnects with a new ticket when the stream drops, then gives up after three failures in a row', async () => {
    const { connection, last, clients, tickets } = setup()
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    last().connects()
    last().drops()
    expect(connection.status).toBe('reconnecting')
    expect(connection.rfb).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(clients).toHaveLength(2)
    expect(tickets).toHaveLength(2)
    last().drops()
    expect(connection.status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(2_000)
    last().drops()
    expect(connection.status).toBe('unreachable')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clients).toHaveLength(3)
  })

  it('counts failed tickets as failures, and a connection resets the count', async () => {
    const { connection, ticketFailures, last } = setup()
    ticketFailures.push(new Error('fetch failed'), new Error('fetch failed'))
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(3_000)
    last().connects()
    last().drops()
    await vi.advanceTimersByTimeAsync(1_000)
    last().drops()
    expect(connection.status).toBe('reconnecting')
  })

  it('counts a client that fails to open as a failure', async () => {
    let opened = 0
    const { connection, clients } = setup({
      openRfb: async (element, url) => {
        if (++opened === 1) throw new Error('noVNC failed to load')
        const client = new FakeRfb(element, url)
        clients.push(client)
        return client
      },
    })
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(clients).toHaveLength(1)
  })

  it('counts only failures in a row: a booting computer answered', async () => {
    const { connection, ticketFailures, clients } = setup()
    ticketFailures.push(new Error('a'), new Error('b'), notRunning(), new Error('c'))
    connection.start()
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1_500)
    expect(connection.status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(clients).toHaveLength(1)
  })

  it('starts over on retry once unreachable', async () => {
    const { connection, ticketFailures, clients, last } = setup()
    ticketFailures.push(new Error('a'), new Error('b'), new Error('c'))
    connection.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connection.status).toBe('unreachable')
    connection.retry()
    expect(connection.status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(0)
    expect(clients).toHaveLength(1)
    last().connects()
    expect(connection.status).toBe('connected')
  })

  it('disconnects when stopped, and neither reconnects nor reports after', async () => {
    const { connection, statuses, last, clients } = setup()
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    last().connects()
    const reported = statuses.length
    connection.stop()
    expect(last().disconnected).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clients).toHaveLength(1)
    expect(statuses).toHaveLength(reported)
  })

  it('opens nothing when stopped while the ticket is on its way', async () => {
    const { connection, clients } = setup()
    connection.start()
    connection.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clients).toHaveLength(0)
  })
})
