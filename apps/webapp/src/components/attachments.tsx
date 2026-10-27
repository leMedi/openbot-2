import { type AttachmentInfo, attachmentPath } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useLayoutEffect, useRef, useState } from 'react'

/** Where the browser downloads a message's file. */
export const attachmentUrl = (messageId: string, attachment: AttachmentInfo) => `/api${attachmentPath(messageId, attachment.id)}`

/** `size` bytes, for people: `512 B`, `12 KB`, `3.4 MB`. */
export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** Images and videos show in the gallery, audio as a player; every other file is a chip. */
const isMedia = (file: { mimeType: string }) => isImage(file) || file.mimeType.startsWith('video/')
const isAudio = (file: { mimeType: string }) => file.mimeType.startsWith('audio/')
const isImage = (file: { mimeType: string }) => file.mimeType.startsWith('image/') && file.mimeType !== 'image/svg+xml'

/** Grok's sidebar summary of a message with files and no text: "Sent 2 images", "Sent a file". */
export function summarizeAttachments(attachments: readonly { mimeType: string }[]): string {
  const count = attachments.length
  const kind = attachments.every(isImage) ? 'image' : attachments.every((file) => file.mimeType.startsWith('video/')) ? 'video' : 'file'
  return count === 1 ? `Sent ${kind === 'image' ? 'an image' : `a ${kind}`}` : `Sent ${count} ${kind}s`
}

/**
 * A message's files in Grok's transcript styles: images and videos in a gallery (320px high at most, 10px corners) that
 * opens the full-screen viewer, every other file as a chip that downloads it.
 */
export function Attachments({ messageId, attachments, mine }: { messageId: string; attachments: AttachmentInfo[]; mine: boolean }) {
  const [viewing, setViewing] = useState<number>()
  const media = attachments.filter(isMedia)
  const audio = attachments.filter(isAudio)
  const files = attachments.filter((file) => !isMedia(file) && !isAudio(file))
  return (
    <>
      {media.length > 0 && (
        <div className={cn('flex max-w-full flex-wrap gap-1', mine && 'justify-end')}>
          {media.map((file, index) => (
            <button
              key={file.id}
              type="button"
              onClick={() => setViewing(index)}
              aria-label={`View ${file.name}`}
              title={file.path}
              className="pressable overflow-hidden rounded-[10px] bg-secondary"
            >
              {isImage(file) ? (
                <img src={attachmentUrl(messageId, file)} alt={file.name} className="block max-h-80 max-w-full object-contain" />
              ) : (
                <video src={attachmentUrl(messageId, file)} muted preload="metadata" className="block max-h-80 max-w-full" />
              )}
            </button>
          ))}
        </div>
      )}
      {audio.map((file) => (
        <audio key={file.id} src={attachmentUrl(messageId, file)} controls preload="metadata" title={file.name} className="max-w-full" />
      ))}
      {files.length > 0 && (
        <div className={cn('flex max-w-full flex-wrap gap-1', mine && 'justify-end')}>
          {files.map((file) => (
            <a
              key={file.id}
              href={attachmentUrl(messageId, file)}
              download={file.name}
              title={file.path}
              className="pressable flex max-w-[260px] items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-2 hover:bg-muted"
            >
              <FileIcon />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{file.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{formatSize(file.size)}</span>
              </span>
            </a>
          ))}
        </div>
      )}
      {viewing !== undefined && (
        <MediaViewer messageId={messageId} media={media} index={viewing} onIndex={setViewing} onClose={() => setViewing(undefined)} />
      )}
    </>
  )
}

/** Grok's full-screen media viewer: a dark scrim, arrows and ←/→ between a message's images, Esc to close. */
function MediaViewer({
  messageId,
  media,
  index,
  onIndex,
  onClose,
}: {
  messageId: string
  media: AttachmentInfo[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const file = media[index]!
  useLayoutEffect(() => {
    if (!ref.current?.open) ref.current?.showModal()
  }, [])
  const step = (by: number) => onIndex((index + by + media.length) % media.length)
  return (
    <dialog
      ref={ref}
      aria-label={file.name}
      onClose={onClose}
      onClick={(event) => event.target === event.currentTarget && ref.current?.close()}
      onKeyDown={(event) => {
        if (media.length < 2) return
        if (event.key === 'ArrowRight') step(1)
        if (event.key === 'ArrowLeft') step(-1)
      }}
      className="media-viewer m-0 flex h-dvh max-h-none w-dvw max-w-none items-center justify-center bg-transparent p-12 text-white backdrop:bg-scrim-heavy"
    >
      {isImage(file) ? (
        <img src={attachmentUrl(messageId, file)} alt={file.name} className="max-h-full max-w-full rounded-[10px] object-contain" />
      ) : (
        <video src={attachmentUrl(messageId, file)} controls autoPlay className="max-h-full max-w-full rounded-[10px]" />
      )}
      <div className="absolute top-3 right-3 flex items-center gap-2 text-sm">
        <span className="max-w-[40vw] truncate opacity-80">{file.name}</span>
        <a href={attachmentUrl(messageId, file)} download={file.name} className={viewerButton}>
          Download
        </a>
        <button type="button" autoFocus onClick={() => ref.current?.close()} className={viewerButton} aria-label="Close">
          ✕
        </button>
      </div>
      {media.length > 1 && (
        <>
          <button type="button" aria-label="Previous" onClick={() => step(-1)} className={cn(viewerButton, 'absolute top-1/2 left-3 -translate-y-1/2')}>
            ←
          </button>
          <button type="button" aria-label="Next" onClick={() => step(1)} className={cn(viewerButton, 'absolute top-1/2 right-3 -translate-y-1/2')}>
            →
          </button>
        </>
      )}
    </dialog>
  )
}

const viewerButton = 'pressable rounded-full bg-white/15 px-3 py-1.5 text-white hover:bg-white/25'

export function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden
      className={cn('shrink-0 text-muted-foreground', className)}
    >
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5.25h3.5" />
    </svg>
  )
}
