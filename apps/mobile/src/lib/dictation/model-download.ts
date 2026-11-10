import type { KeyValueStorage } from '@openbot/client'
import { dictationDownloadKey } from '../storage-keys.ts'

/** The network the phone is on, as the download cares: whether there is one, and whether it costs (cellular). */
export type Network = { connected: boolean; metered: boolean }

/** What a transfer that keeps the network rules itself is waiting for. */
export type Waiting = 'wifi' | 'network'

/** One download of the model into a partial file, which can be paused and run again from where it was. */
export type Transfer = {
  /**
   * Starts or resumes it; resolves true once the whole file is there, false once paused or discarded. A transfer that
   * keeps the network rules itself says what it waits for with its progress.
   */
  run(onProgress: (bytes: number, waiting?: Waiting) => void): Promise<boolean>
  pause(): Promise<void>
  /** Stops it and drops the partial file. */
  discard(): void
  /**
   * Set when the system keeps the network rules for it (Android's DownloadManager, which goes on in the background):
   * whether it may use cellular data. It's never paused for the network, and changing the leave starts it again.
   */
  readonly cellular?: boolean
}

/** The model's file on the phone. */
export type ModelFiles = {
  /** Whether the whole model is in place. */
  isReady(): boolean
  /** A new transfer; `cellular` is for one that keeps the network rules itself. */
  newTransfer(cellular: boolean): Transfer
  /** Checks the downloaded file and puts it in place; throws if it isn't the model. */
  install(): void
  remove(): void
}

export type ModelState =
  | { kind: 'absent' }
  | { kind: 'ready' }
  /** Under way: moving, or held while the phone is on cellular without leave to use it, or offline. */
  | { kind: 'downloading'; fraction: number; cellular: boolean; waitingForWifi: boolean; offline: boolean }
  | { kind: 'failed'; fraction: number; cellular: boolean; message: string }

type Listener = (state: ModelState) => void

/**
 * Gets the voice model onto the phone once, as the owner asks for it: on Wi-Fi unless they allow cellular data, held
 * while the phone is on cellular and resumed on Wi-Fi. Its state is what the mic and Settings → Dictation show.
 */
export class ModelDownload {
  state: ModelState
  private listeners = new Set<Listener>()
  private transfer?: Transfer
  private bytes = 0
  private running = false
  private unwatch?: () => void

  constructor(
    private deps: {
      files: ModelFiles
      totalBytes: number
      storage: KeyValueStorage
      network: { current(): Promise<Network>; subscribe(listener: (network: Network) => void): () => void }
    },
  ) {
    this.state = deps.files.isReady() ? { kind: 'ready' } : { kind: 'absent' }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(state: ModelState) {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }

  private get fraction() {
    return Math.min(1, this.bytes / this.deps.totalBytes)
  }

  /** Starts downloading, on Wi-Fi only unless `cellular`, or tries a failed download again. */
  start({ cellular }: { cellular: boolean }) {
    if (this.state.kind === 'ready' || this.state.kind === 'downloading') return
    this.remember(cellular)
    this.set({ kind: 'downloading', fraction: this.fraction, cellular, waitingForWifi: false, offline: false })
    this.unwatch ??= this.deps.network.subscribe((network) => this.reconsider(network))
    void this.check()
  }

  /** Allows or stops using cellular data for the download. */
  setCellular(cellular: boolean) {
    if (this.state.kind !== 'downloading' && this.state.kind !== 'failed') return
    this.remember(cellular)
    this.set({ ...this.state, cellular })
    if (this.transfer?.cellular !== undefined && this.transfer.cellular !== cellular) {
      // The system's download can't change its leave: it starts again with the new one.
      this.transfer.discard()
      this.transfer = undefined
      this.bytes = 0
      if (this.state.kind === 'downloading') this.set({ ...this.state, fraction: 0, waitingForWifi: false, offline: false })
    }
    void this.check()
  }

  /** Carries on with a download that was under way when the app last ran. */
  resume() {
    if (this.state.kind !== 'absent') return
    const wanted = rememberedDownload(this.deps.storage)
    if (wanted) this.start(wanted)
  }

  /** Stops a download and drops what it got. */
  cancel() {
    if (this.state.kind !== 'downloading' && this.state.kind !== 'failed') return
    this.drop()
    this.set({ kind: 'absent' })
  }

  /** Deletes the model from the phone (or stops its download); the mic offers to download it again. */
  remove() {
    this.drop()
    this.deps.files.remove()
    this.set({ kind: 'absent' })
  }

  private drop() {
    this.transfer?.discard()
    this.transfer = undefined
    this.bytes = 0
    this.stopWatching()
    this.deps.storage.removeItem(dictationDownloadKey)
  }

  /** Keeps that a download is wanted, and with what leave, so it carries on after a restart. */
  private remember(cellular: boolean) {
    this.deps.storage.setItem(dictationDownloadKey, JSON.stringify({ cellular }))
  }

  private async check() {
    this.reconsider(await this.deps.network.current())
  }

  /** Runs or holds the download for the network the phone is on. */
  private reconsider(network: Network) {
    if (this.state.kind !== 'downloading') return
    const { cellular } = this.state
    if (this.transfer?.cellular !== undefined) {
      // The system holds it on cellular itself, in the background too.
      if (!this.running) void this.go()
      return
    }
    const allowed = network.connected && (!network.metered || cellular)
    this.set({ ...this.state, waitingForWifi: network.connected && network.metered && !cellular, offline: !network.connected })
    if (allowed && !this.running) void this.go()
    else if (!allowed && this.running) void this.transfer?.pause()
  }

  private async go() {
    this.running = true
    const transfer = (this.transfer ??= this.deps.files.newTransfer(this.state.kind === 'downloading' && this.state.cellular))
    try {
      const done = await transfer.run((bytes, waiting) => {
        if (this.transfer !== transfer) return
        this.bytes = bytes
        if (this.state.kind !== 'downloading') return
        const held = transfer.cellular !== undefined ? { waitingForWifi: waiting === 'wifi', offline: waiting === 'network' } : {}
        this.set({ ...this.state, ...held, fraction: this.fraction })
      })
      if (this.transfer !== transfer) return
      if (!done) {
        // Paused: the network may have changed back while it was pausing.
        this.running = false
        return void this.check()
      }
      try {
        this.deps.files.install()
      } catch (error) {
        // Not the model: the next try starts over.
        transfer.discard()
        this.transfer = undefined
        this.bytes = 0
        throw error
      }
      this.transfer = undefined
      this.stopWatching()
      this.deps.storage.removeItem(dictationDownloadKey)
      this.set({ kind: 'ready' })
    } catch (error) {
      if (this.state.kind !== 'downloading' || (this.transfer && this.transfer !== transfer)) return
      this.set({ kind: 'failed', fraction: this.fraction, cellular: this.state.cellular, message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.running = false
    }
  }

  private stopWatching() {
    this.unwatch?.()
    this.unwatch = undefined
  }
}

function rememberedDownload(storage: KeyValueStorage): { cellular: boolean } | undefined {
  try {
    const wish = JSON.parse(storage.getItem(dictationDownloadKey) ?? 'null') as { cellular?: unknown } | null
    return wish ? { cellular: wish.cellular === true } : undefined
  } catch {
    return undefined
  }
}

/** The model's state in a few words: Settings → Dictation's row. */
export function modelStatus(state: ModelState): string {
  switch (state.kind) {
    case 'absent':
      return 'Not downloaded'
    case 'ready':
      return 'Downloaded'
    case 'failed':
      return 'Download stopped'
    case 'downloading': {
      const percent = `${Math.floor(state.fraction * 100)}%`
      if (state.offline) return `Waiting for a connection · ${percent}`
      if (state.waitingForWifi) return `Waiting for Wi-Fi · ${percent}`
      return `Downloading… ${percent}`
    }
  }
}
