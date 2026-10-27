import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Attachment } from '@openbot/db'
import { uuidv7 } from 'uuidv7'

/** At most this many files go with one message (Grok's composer limit). */
export const maxAttachments = 6

/** The largest file a message can carry, either way. */
export const maxAttachmentBytes = 50 * 1024 * 1024

/** Media types of common file extensions; anything else is `application/octet-stream`. */
const mimeTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

/** A file's media type, from its extension. */
export function mimeTypeOf(name: string): string {
  return mimeTypes[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * A file name safe to write in a folder: no directories, no control characters, never `.` or `..`, at most 200
 * characters with its extension kept.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!base || base === '.' || base === '..') return 'file'
  if (base.length <= 200) return base
  const ext = extname(base).slice(0, 20)
  return base.slice(0, 200 - ext.length) + ext
}

/** One file of a message being posted: what it is, and its bytes. */
export type AttachmentFile = Omit<Attachment, 'id' | 'size'> & { bytes: Uint8Array }

/**
 * The copies of every message's files the owner downloads, kept by the server in its data dir, one folder per chat. A
 * copy stays as it was when the message was posted, whatever later happens to the file on the computer.
 */
export class AttachmentStore {
  constructor(readonly dir: string) {}

  /** Keeps copies of `files` for a message in `chatId`; returns them as the message lists them. */
  async save(chatId: string, files: readonly AttachmentFile[]): Promise<Attachment[]> {
    if (!files.length) return []
    await mkdir(this.#chatDir(chatId), { recursive: true })
    return Promise.all(
      files.map(async ({ bytes, ...file }) => {
        const id = uuidv7()
        await writeFile(join(this.#chatDir(chatId), id), bytes)
        return { id, ...file, size: bytes.byteLength }
      }),
    )
  }

  /** The bytes of an attachment, or undefined when its copy is gone. */
  async read(chatId: string, attachmentId: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    if (!/^[\w-]+$/.test(attachmentId)) return undefined
    try {
      return await readFile(join(this.#chatDir(chatId), attachmentId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Drops copies kept for a message that was never posted. */
  async discard(chatId: string, attachments: readonly Attachment[]): Promise<void> {
    await Promise.all(attachments.map((attachment) => rm(join(this.#chatDir(chatId), attachment.id), { force: true })))
  }

  /** Drops every copy of a deleted chat. */
  async removeChat(chatId: string): Promise<void> {
    await rm(this.#chatDir(chatId), { recursive: true, force: true })
  }

  #chatDir(chatId: string) {
    return join(this.dir, chatId)
  }
}
