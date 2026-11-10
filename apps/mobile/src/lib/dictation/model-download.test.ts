import type { KeyValueStorage } from '@openbot/client'
import { describe, expect, it } from 'vitest'
import { ModelDownload, modelStatus, type ModelFiles, type Network, type Transfer, type Waiting } from './model-download.ts'

const total = 1000

/** A transfer the test drives: it reports bytes, completes, pauses or fails when told. */
class FakeTransfer implements Transfer {
  constructor(readonly cellular?: boolean) {}
  bytes = 0
  runs = 0
  pauses = 0
  discarded = false
  private settle?: (done: boolean) => void
  private fail?: (error: Error) => void
  private progress?: (bytes: number, waiting?: Waiting) => void
  run(onProgress: (bytes: number, waiting?: Waiting) => void) {
    this.runs++
    this.progress = onProgress
    return new Promise<boolean>((resolve, reject) => {
      this.settle = resolve
      this.fail = reject
    })
  }
  async pause() {
    this.pauses++
    this.settle?.(false)
  }
  discard() {
    this.discarded = true
    this.settle?.(false)
  }
  advance(bytes: number, waiting?: Waiting) {
    this.bytes = bytes
    this.progress?.(bytes, waiting)
  }
  complete() {
    this.advance(total)
    this.settle?.(true)
  }
  error(message: string) {
    this.fail?.(new Error(message))
  }
}

function setup({
  network = { connected: true, metered: false } as Network,
  ready = false,
  stored = {} as Record<string, string>,
  /** Transfers that keep the network rules themselves, as Android's DownloadManager. */
  systemRules = false,
} = {}) {
  const transfers: FakeTransfer[] = []
  const files: ModelFiles & { ready: boolean; installed: number; removed: number } = {
    ready,
    installed: 0,
    removed: 0,
    isReady: () => files.ready,
    newTransfer: (cellular) => {
      const transfer = new FakeTransfer(systemRules ? cellular : undefined)
      transfers.push(transfer)
      return transfer
    },
    install: () => {
      files.installed++
      files.ready = true
    },
    remove: () => {
      files.removed++
      files.ready = false
    },
  }
  const listeners = new Set<(network: Network) => void>()
  let current = network
  const map = new Map(Object.entries(stored))
  const storage: KeyValueStorage = {
    keys: () => [...map.keys()],
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
  const download = new ModelDownload({
    files,
    totalBytes: total,
    storage,
    network: {
      current: async () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
  const changeNetwork = async (next: Network) => {
    current = next
    for (const listener of listeners) listener(next)
    await settled()
  }
  return { download, files, transfers, storage: map, changeNetwork }
}

/** Lets the controller's awaited steps run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the voice model’s download', () => {
  it('is absent until asked for, and ready once a download on Wi-Fi completes', async () => {
    const { download, files, transfers } = setup()
    expect(download.state).toEqual({ kind: 'absent' })

    download.start({ cellular: false })
    await settled()
    transfers[0].advance(250)
    expect(download.state).toMatchObject({ kind: 'downloading', fraction: 0.25, waitingForWifi: false })

    transfers[0].complete()
    await settled()
    expect(files.installed).toBe(1)
    expect(download.state).toEqual({ kind: 'ready' })
  })

  it('waits for Wi-Fi on cellular, then downloads', async () => {
    const { download, transfers, changeNetwork } = setup({ network: { connected: true, metered: true } })
    download.start({ cellular: false })
    await settled()
    expect(transfers).toHaveLength(0)
    expect(download.state).toMatchObject({ kind: 'downloading', fraction: 0, waitingForWifi: true })

    await changeNetwork({ connected: true, metered: false })
    expect(transfers).toHaveLength(1)
    expect(download.state).toMatchObject({ kind: 'downloading', waitingForWifi: false })
  })

  it('pauses when the phone moves to cellular and picks up where it was on Wi-Fi', async () => {
    const { download, transfers, changeNetwork } = setup()
    download.start({ cellular: false })
    await settled()
    transfers[0].advance(400)

    await changeNetwork({ connected: true, metered: true })
    expect(transfers[0].pauses).toBe(1)
    expect(download.state).toMatchObject({ kind: 'downloading', fraction: 0.4, waitingForWifi: true })

    await changeNetwork({ connected: true, metered: false })
    expect(transfers).toHaveLength(1)
    expect(transfers[0].runs).toBe(2)
    expect(download.state).toMatchObject({ kind: 'downloading', fraction: 0.4, waitingForWifi: false })
  })

  it('uses cellular data once allowed, even mid-download', async () => {
    const { download, transfers } = setup({ network: { connected: true, metered: true } })
    download.start({ cellular: false })
    await settled()
    download.setCellular(true)
    await settled()
    expect(transfers).toHaveLength(1)
    expect(download.state).toMatchObject({ kind: 'downloading', cellular: true, waitingForWifi: false })

    download.setCellular(false)
    await settled()
    expect(transfers[0].pauses).toBe(1)
    expect(download.state).toMatchObject({ kind: 'downloading', cellular: false, waitingForWifi: true })
  })

  it('fails with the reason, and tries again from where it was', async () => {
    const { download, transfers } = setup()
    download.start({ cellular: false })
    await settled()
    transfers[0].advance(300)
    transfers[0].error('The network connection was lost.')
    await settled()
    expect(download.state).toEqual({ kind: 'failed', fraction: 0.3, cellular: false, message: 'The network connection was lost.' })

    download.start({ cellular: false })
    await settled()
    expect(transfers).toHaveLength(1)
    expect(transfers[0].runs).toBe(2)
    expect(download.state).toMatchObject({ kind: 'downloading', fraction: 0.3 })
  })

  it('fails, starting over next time, when the file downloaded isn’t the model', async () => {
    const { download, files, transfers } = setup()
    files.install = () => {
      throw new Error('The voice model didn’t download completely.')
    }
    download.start({ cellular: false })
    await settled()
    transfers[0].complete()
    await settled()
    expect(transfers[0].discarded).toBe(true)
    expect(download.state).toMatchObject({ kind: 'failed', fraction: 0, message: 'The voice model didn’t download completely.' })

    download.start({ cellular: false })
    await settled()
    expect(transfers).toHaveLength(2)
  })

  it('can be cancelled, dropping what was downloaded', async () => {
    const { download, transfers } = setup()
    download.start({ cellular: false })
    await settled()
    transfers[0].advance(500)
    download.cancel()
    await settled()
    expect(transfers[0].discarded).toBe(true)
    expect(download.state).toEqual({ kind: 'absent' })
  })

  it('deletes the model', async () => {
    const { download, files } = setup({ ready: true })
    expect(download.state).toEqual({ kind: 'ready' })
    download.remove()
    expect(files.removed).toBe(1)
    expect(download.state).toEqual({ kind: 'absent' })
  })

  it('carries on after the app restarts, with the same leave to use cellular', async () => {
    const first = setup({ network: { connected: true, metered: true } })
    first.download.start({ cellular: true })
    await settled()

    const again = setup({ network: { connected: true, metered: true }, stored: Object.fromEntries(first.storage) })
    again.download.resume()
    await settled()
    expect(again.transfers).toHaveLength(1)
    expect(again.download.state).toMatchObject({ kind: 'downloading', cellular: true, waitingForWifi: false })
  })

  it('doesn’t start by itself unless a download was under way', async () => {
    const { download, transfers } = setup()
    download.resume()
    await settled()
    expect(transfers).toHaveLength(0)
    expect(download.state).toEqual({ kind: 'absent' })
  })

  it('forgets the download once the model is in place, or cancelled', async () => {
    const { download, transfers, storage } = setup()
    download.start({ cellular: false })
    await settled()
    expect(storage.size).toBe(1)
    transfers[0].complete()
    await settled()
    expect(storage.size).toBe(0)
  })
})

describe('the voice model’s download, kept to Wi-Fi by the system (Android)', () => {
  it('isn’t paused on cellular, and shows when the system waits for Wi-Fi', async () => {
    const { download, transfers, changeNetwork } = setup({ systemRules: true })
    download.start({ cellular: false })
    await settled()
    expect(transfers[0].cellular).toBe(false)
    transfers[0].advance(200)

    await changeNetwork({ connected: true, metered: true })
    transfers[0].advance(200, 'wifi')
    expect(transfers[0].pauses).toBe(0)
    expect(download.state).toMatchObject({ kind: 'downloading', fraction: 0.2, waitingForWifi: true, offline: false })

    transfers[0].advance(300)
    expect(download.state).toMatchObject({ kind: 'downloading', fraction: 0.3, waitingForWifi: false })
    transfers[0].advance(300, 'network')
    expect(download.state).toMatchObject({ offline: true })
  })

  it('starts again with the new leave when cellular data is allowed', async () => {
    const { download, transfers } = setup({ systemRules: true })
    download.start({ cellular: false })
    await settled()
    transfers[0].advance(200, 'wifi')
    download.setCellular(true)
    await settled()
    expect(transfers[0].discarded).toBe(true)
    expect(transfers).toHaveLength(2)
    expect(transfers[1].cellular).toBe(true)
    expect(transfers[1].runs).toBe(1)
    expect(download.state).toMatchObject({ kind: 'downloading', fraction: 0, cellular: true, waitingForWifi: false })
  })
})

describe('the voice model’s status, as Settings shows it', () => {
  it('says where the download is', () => {
    expect(modelStatus({ kind: 'absent' })).toBe('Not downloaded')
    expect(modelStatus({ kind: 'ready' })).toBe('Downloaded')
    expect(modelStatus({ kind: 'downloading', fraction: 0.426, cellular: false, waitingForWifi: false, offline: false })).toBe('Downloading… 42%')
    expect(modelStatus({ kind: 'downloading', fraction: 0.1, cellular: false, waitingForWifi: true, offline: false })).toBe('Waiting for Wi-Fi · 10%')
    expect(modelStatus({ kind: 'downloading', fraction: 0.1, cellular: true, waitingForWifi: false, offline: true })).toBe('Waiting for a connection · 10%')
    expect(modelStatus({ kind: 'failed', fraction: 0.1, cellular: false, message: 'Lost' })).toBe('Download stopped')
  })
})
