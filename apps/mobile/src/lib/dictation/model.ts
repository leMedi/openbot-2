import { getNetworkStateAsync, addNetworkStateListener } from 'expo-network'
import { Directory, File, Paths } from 'expo-file-system'
import type { DownloadTask } from 'expo-file-system'
import { useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import Native from '../../../modules/dictation-native/index.ts'
import { kvStorage } from '../storage.ts'
import { systemDownloadKey } from '../storage-keys.ts'
import { ModelDownload, type ModelFiles, type Network, type Transfer } from './model-download.ts'

/** Parakeet TDT 0.6B v3, quantized to q4_0 for whisper.rn (spec: Dictation; chosen in #92). */
export const voiceModel = {
  name: 'Parakeet TDT 0.6B v3',
  url: 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q4_0.bin',
  bytes: 355_615_679,
  /** As the owner is told: "Download the voice model (356 MB)?" */
  size: '356 MB',
}

// In documents, which the OS doesn't purge as it may the cache; the partial file sits next to it until complete. New
// File objects each time, as one that is moved takes the path it was moved to.
const folder = () => new Directory(Paths.document, 'dictation')
const modelName = 'parakeet-tdt-0.6b-v3-q4_0.bin'
/** The model, once complete; what whisper.rn loads. */
export const modelFile = () => new File(folder(), modelName)
const partFile = () => new File(folder(), `${modelName}.part`)

export function deleteIfThere(file: File) {
  if (file.exists) file.delete()
}

const stopped = 'The download stopped. Check your connection, then try again.'

/** One expo-file-system download task into the partial file: on iOS a background session, so it goes on in the background. */
function sessionTransfer(): Transfer {
  let task: DownloadTask | undefined
  let started = false
  return {
    async run(onProgress) {
      folder().create({ idempotent: true, intermediates: true })
      if (!task) {
        deleteIfThere(partFile())
        task = File.createDownloadTask(voiceModel.url, partFile(), {
          // A BigInt on iOS (an Int64 there).
          onProgress: ({ bytesWritten }) => onProgress(Number(bytesWritten)),
        })
      }
      try {
        const file = started ? await task.resumeAsync() : ((started = true), await task.downloadAsync())
        return file !== null
      } catch {
        throw new Error(stopped)
      }
    },
    async pause() {
      await task?.pauseAsync()
    },
    discard() {
      task?.cancel()
      task = undefined
      deleteIfThere(partFile())
    },
  }
}

/**
 * Android's: the system's DownloadManager downloads it, as Android cuts the app's own connections in the background.
 * It goes on with the app closed, and keeps to Wi-Fi itself unless `cellular`; its id is kept so the next launch picks
 * it up. Once done, the file moves into the partial file's place.
 */
function systemTransfer(cellular: boolean): Transfer {
  let stop: (() => void) | undefined
  const stored = () => {
    const id = Number(kvStorage.getItem(systemDownloadKey))
    return Number.isFinite(id) && id > 0 ? id : undefined
  }
  return {
    cellular,
    run(onProgress) {
      let id = stored()
      const status = id === undefined ? undefined : Native.downloadStatus(id).status
      if (id === undefined || status === 'missing' || status === 'failed') {
        if (id !== undefined) Native.cancelDownload(id)
        id = Native.startDownload(voiceModel.url, modelName, 'Voice model for dictation', cellular)
        kvStorage.setItem(systemDownloadKey, String(id))
      }
      const download = id
      return new Promise<boolean>((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            const { status, bytes } = Native.downloadStatus(download)
            if (status === 'done') {
              finish()
              Native.installDownload(download, partFile().uri)
              kvStorage.removeItem(systemDownloadKey)
              resolve(true)
            } else if (status === 'failed' || status === 'missing') {
              finish()
              Native.cancelDownload(download)
              kvStorage.removeItem(systemDownloadKey)
              reject(new Error(stopped))
            } else {
              onProgress(bytes, status === 'waiting-wifi' ? 'wifi' : status === 'waiting-network' ? 'network' : undefined)
            }
          } catch (error) {
            finish()
            reject(error)
          }
        }, 500)
        const finish = () => {
          clearInterval(timer)
          stop = undefined
        }
        stop = () => {
          finish()
          resolve(false)
        }
      })
    },
    // Never asked of a transfer that keeps the network rules itself.
    async pause() {},
    discard() {
      stop?.()
      const id = stored()
      if (id !== undefined) Native.cancelDownload(id)
      kvStorage.removeItem(systemDownloadKey)
      deleteIfThere(partFile())
    },
  }
}

const files: ModelFiles = {
  isReady: () => {
    const model = modelFile()
    return model.exists && model.size === voiceModel.bytes
  },
  newTransfer: (cellular) => (Platform.OS === 'android' ? systemTransfer(cellular) : sessionTransfer()),
  install() {
    const part = partFile()
    if (!part.exists || part.size !== voiceModel.bytes) {
      deleteIfThere(part)
      throw new Error('The voice model didn’t download completely. Try again.')
    }
    deleteIfThere(modelFile())
    part.moveSync(modelFile())
  },
  remove() {
    deleteIfThere(modelFile())
    deleteIfThere(partFile())
  },
}

const network = {
  async current(): Promise<Network> {
    const state = await getNetworkStateAsync()
    return { connected: state.isConnected !== false, metered: Native.isNetworkMetered() }
  },
  subscribe(listener: (network: Network) => void) {
    const subscription = addNetworkStateListener((state) => listener({ connected: state.isConnected !== false, metered: Native.isNetworkMetered() }))
    return () => subscription.remove()
  },
}

/** The phone's one voice model download, kept across screens. */
export const modelDownload = new ModelDownload({ files, totalBytes: voiceModel.bytes, storage: kvStorage, network })

/** The voice model's state, live. */
export function useModelState() {
  return useSyncExternalStore(
    (onChange) => modelDownload.subscribe(onChange),
    () => modelDownload.state,
  )
}
