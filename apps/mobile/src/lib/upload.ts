import type { MessageInfo } from '@openbot/api-contract'

/** A file picked on the phone (photo library, camera or Files), sent from disk by its URI. */
export type PickedFile = { uri: string; name: string; size: number; mimeType: string }

/** What `sendWithFiles` uses of React Native's XMLHttpRequest. */
export type RequestLike = {
  open(method: string, url: string): void
  send(body: unknown): void
  abort(): void
  status: number
  responseText: string
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  ontimeout: (() => void) | null
}

/** What `sendWithFiles` uses of React Native's FormData, whose `append` takes a `{uri, name, type}` file from disk. */
export type FormLike = { append(name: string, value: unknown): void }

/**
 * Posts the owner's message with files to `chats.send`, as the API's client would (a multipart form with `text` and
 * `files[0]`, `files[1]`… at `POST /api/chats/{chatId}/messages`), but through React Native's XHR: files from the
 * native pickers aren't Blobs, so `expo/fetch` can't send them, while XHR streams each straight from disk and reports
 * progress. Resolves with the posted message; rejects with the instance's message, or why it couldn't be reached.
 */
export function sendWithFiles({
  url,
  chatId,
  text,
  files,
  replyToId,
  onProgress,
  signal,
  request = () => new XMLHttpRequest() as unknown as RequestLike,
  form = () => new FormData() as unknown as FormLike,
}: {
  /** The instance, e.g. `http://192.168.1.20:3000`. */
  url: string
  chatId: string
  text: string
  files: readonly PickedFile[]
  /** The chat's message it replies to. */
  replyToId?: string
  /** How much has gone up, from 0 to 1. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  request?: () => RequestLike
  form?: () => FormLike
}): Promise<MessageInfo> {
  return new Promise((resolve, reject) => {
    const body = form()
    body.append('text', text)
    if (replyToId) body.append('replyToId', replyToId)
    files.forEach((file, index) => body.append(`files[${index}]`, { uri: file.uri, name: file.name, type: file.mimeType }))
    const xhr = request()
    xhr.open('POST', new URL(`/api/chats/${encodeURIComponent(chatId)}/messages`, url).href)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
    }
    xhr.onload = () => {
      let answer: unknown
      try {
        answer = JSON.parse(xhr.responseText)
      } catch {
        answer = undefined
      }
      if (xhr.status >= 200 && xhr.status < 300 && answer) return resolve(answer as MessageInfo)
      const message = answer && typeof answer === 'object' && 'message' in answer && typeof answer.message === 'string' ? answer.message : undefined
      reject(new Error(message || `Couldn't send (HTTP ${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error("Couldn't reach OpenBot"))
    xhr.ontimeout = xhr.onerror
    xhr.onabort = () => reject(new Error('Cancelled'))
    const abort = () => xhr.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const settled = <T,>(handler: (value: T) => void) => (value: T) => {
      signal?.removeEventListener('abort', abort)
      handler(value)
    }
    resolve = settled(resolve)
    reject = settled(reject)
    xhr.send(body)
  })
}
