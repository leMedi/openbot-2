/// <reference path="./types/novnc.d.ts" />
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

// Typing on the Screen from a phone, which the phone's Screen takes with the connection.
export * from './screen-keys.ts'

/**
 * Where a bot's Screen connection is: `starting` while its computer boots, `reconnecting` after a stream that was
 * connected dropped, `unreachable` after {@link attemptsBeforeUnreachable} failures in a row, until a retry.
 */
export type ScreenStatus = 'connecting' | 'starting' | 'connected' | 'reconnecting' | 'unreachable'

/** `low` trades picture quality for less data, as on cellular. */
export type ScreenQuality = 'high' | 'low'

/** `fit` scales the whole Screen into its frame; `actual` shows it 1:1, clipped, a drag panning it (a tap still clicks). */
export type ScreenViewport = 'fit' | 'actual'

/** The parts of noVNC's client (https://github.com/novnc/noVNC/blob/master/docs/API.md) the connection sets. */
export type Rfb = EventTarget & {
  viewOnly: boolean
  scaleViewport: boolean
  clipViewport: boolean
  dragViewport: boolean
  background: string
  qualityLevel: number
  compressionLevel: number
  focus(options?: FocusOptions): void
  /** Presses and releases `keysym`, or only presses (`down`) or releases it. */
  sendKey(keysym: number, code: string, down?: boolean): void
  disconnect(): void
}

/** Failed connections in a row before the Screen counts as unreachable. */
const attemptsBeforeUnreachable = 3
/** How often a booting computer is asked for again. */
const startingRetryMs = 1_500
/** The wait before reconnecting grows by this with each failure in a row. */
const failureBackoffMs = 1_000

/** noVNC's JPEG quality and compression (0–9) for each quality; `high` is noVNC's default. */
const qualityLevels: Record<ScreenQuality, { qualityLevel: number; compressionLevel: number }> = {
  high: { qualityLevel: 6, compressionLevel: 2 },
  low: { qualityLevel: 3, compressionLevel: 7 },
}

const viewports: Record<ScreenViewport, Pick<Rfb, 'scaleViewport' | 'clipViewport' | 'dragViewport'>> = {
  fit: { scaleViewport: true, clipViewport: false, dragViewport: false },
  actual: { scaleViewport: false, clipViewport: true, dragViewport: true },
}

export type ScreenConnectionOptions = {
  botId: string
  /** Asks the instance for a ticket to the bot's Screen; `api.screens.ticket`. */
  ticket: (input: { botId: string }) => Promise<{ url: string }>
  /** The instance's address, which the ticket's path is on; the page's own on the web. */
  server: string
  /** Whether the owner controls the Screen; view-only otherwise. */
  interactive?: boolean
  quality?: ScreenQuality
  viewport?: ScreenViewport
  /** Opens noVNC's client on `target`; noVNC itself unless replaced. */
  openRfb?: (target: HTMLElement, url: string) => Promise<Rfb>
  /** Called whenever `status` or `rfb` changes. */
  onChange?: () => void
}

async function openNoVnc(target: HTMLElement, url: string): Promise<Rfb> {
  const { default: RFB } = await import('@novnc/novnc')
  return new RFB(target, url, { shared: true })
}

/**
 * A live connection to a bot's Screen in `target`: a ticket, then noVNC over a WebSocket, getting a new ticket and
 * reconnecting when the stream drops. Control and quality change without reconnecting.
 */
export class ScreenConnection {
  status: ScreenStatus = 'connecting'
  /** noVNC's client while connected. */
  rfb: Rfb | undefined

  private options: ScreenConnectionOptions
  private interactive: boolean
  private quality: ScreenQuality
  private viewport: ScreenViewport
  /** The client opened last, connected or not. */
  private client: Rfb | undefined
  private failures = 0
  private connected = false
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Bumped by start, retry and stop, so work from an earlier attempt is dropped. */
  private generation = 0

  constructor(
    private target: HTMLElement,
    options: ScreenConnectionOptions,
  ) {
    this.options = options
    this.interactive = options.interactive ?? false
    this.quality = options.quality ?? 'high'
    this.viewport = options.viewport ?? 'fit'
  }

  start() {
    this.reset()
    this.setStatus('connecting')
    void this.connect(this.generation)
  }

  /** Starts over, e.g. from unreachable. */
  retry() {
    this.start()
  }

  stop() {
    this.reset()
  }

  setInteractive(interactive: boolean) {
    this.interactive = interactive
    if (!this.client) return
    this.client.viewOnly = !interactive
  }

  setQuality(quality: ScreenQuality) {
    this.quality = quality
    if (this.client) Object.assign(this.client, qualityLevels[quality])
  }

  setViewport(viewport: ScreenViewport) {
    this.viewport = viewport
    if (this.client) Object.assign(this.client, viewports[viewport])
  }

  private reset() {
    this.generation++
    clearTimeout(this.timer)
    this.failures = 0
    this.connected = false
    const client = this.client
    this.client = undefined
    this.rfb = undefined
    client?.disconnect()
  }

  private setStatus(status: ScreenStatus) {
    this.status = status
    this.options.onChange?.()
  }

  private connectAfter(generation: number, delayMs: number) {
    this.timer = setTimeout(() => void this.connect(generation), delayMs)
  }

  private async connect(generation: number) {
    const { botId, ticket, server, openRfb = openNoVnc } = this.options
    let url: string
    try {
      url = (await ticket({ botId })).url
    } catch (error) {
      if (generation !== this.generation) return
      if ((error as { code?: string }).code === 'PRECONDITION_FAILED') {
        // The instance answered: only failures in a row count.
        this.failures = 0
        this.setStatus('starting')
        return this.connectAfter(generation, startingRetryMs)
      }
      return this.fail(generation)
    }
    if (generation !== this.generation) return
    const stream = new URL(url, server)
    stream.protocol = stream.protocol === 'https:' ? 'wss:' : 'ws:'
    let client: Rfb
    try {
      client = await openRfb(this.target, stream.href)
    } catch {
      return generation === this.generation ? this.fail(generation) : undefined
    }
    if (generation !== this.generation) return client.disconnect()
    Object.assign(client, viewports[this.viewport])
    client.background = 'transparent'
    client.viewOnly = !this.interactive
    Object.assign(client, qualityLevels[this.quality])
    client.addEventListener('connect', () => {
      if (generation !== this.generation || this.client !== client) return
      this.failures = 0
      this.connected = true
      this.rfb = client
      this.setStatus('connected')
    })
    client.addEventListener('disconnect', () => {
      if (generation !== this.generation || this.client !== client) return
      this.client = undefined
      this.rfb = undefined
      this.fail(generation)
    })
    this.client = client
  }

  private fail(generation: number) {
    if (++this.failures >= attemptsBeforeUnreachable) return this.setStatus('unreachable')
    this.setStatus(this.connected ? 'reconnecting' : 'connecting')
    this.connectAfter(generation, failureBackoffMs * this.failures)
  }
}

export type ScreenConnectionHookOptions = {
  /** The instance's API, or as much of it as the ticket needs (a DOM component on the phone gets it from the app). */
  api: { screens: { ticket: (input: { botId: string }) => Promise<{ url: string }> } }
  botId: string
  interactive?: boolean
  quality?: ScreenQuality
  viewport?: ScreenViewport
  /** The instance's address; the page's own by default. */
  server?: string
}

/**
 * Connects `target` to a bot's Screen while mounted (see {@link ScreenConnection}), reconnecting for another bot or
 * instance; control, quality and viewport change in place, and taking control takes the keyboard. `target` must be
 * rendered from the start, as the hook connects once it has mounted. Owns no markup: the app draws `target` and the
 * status around it. `rfb` is noVNC's client while connected, for an app's own controls (keys, the keyboard).
 */
export function useScreenConnection(
  target: RefObject<HTMLElement | null>,
  { api, botId, interactive = false, quality = 'high', viewport = 'fit', server }: ScreenConnectionHookOptions,
): { status: ScreenStatus; retry: () => void; rfb: Rfb | undefined } {
  const [state, setState] = useState<{ status: ScreenStatus; rfb: Rfb | undefined }>({ status: 'connecting', rfb: undefined })
  const connection = useRef<ScreenConnection>(undefined)
  const latest = useRef({ interactive, quality, viewport })
  latest.current = { interactive, quality, viewport }

  useEffect(() => {
    if (!target.current) return
    const next: ScreenConnection = new ScreenConnection(target.current, {
      botId,
      ticket: (input) => api.screens.ticket(input),
      server: server ?? window.location.href,
      ...latest.current,
      onChange: () => setState({ status: next.status, rfb: next.rfb }),
    })
    connection.current = next
    next.start()
    return () => {
      next.stop()
      connection.current = undefined
    }
  }, [target, api, botId, server])

  const { status, rfb } = state
  useEffect(() => connection.current?.setInteractive(interactive), [interactive])
  // Control takes the keyboard once connected, or when taken; after rendering, as the app may hide `target` until then.
  useEffect(() => {
    if (interactive && status === 'connected') connection.current?.rfb?.focus()
  }, [status, interactive])
  useEffect(() => connection.current?.setQuality(quality), [quality])
  useEffect(() => connection.current?.setViewport(viewport), [viewport])

  const retry = useCallback(() => connection.current?.retry(), [])
  return { status, retry, rfb }
}
