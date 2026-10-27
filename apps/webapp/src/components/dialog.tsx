import { cn } from '@openbot/ui/lib/utils'
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react'

/** Matches `.dialog[data-closing]` in styles.css. */
const exitMs = 150

/**
 * A modal on the native `<dialog>`: Esc closes it, focus stays inside and the page behind is inert. Mount it to open
 * it; it focuses the element marked `data-autofocus`, else the first focusable one. Its contents stack with a 16px
 * gap. `children` gets `close`, which fades the dialog out and then calls `onClose`.
 */
export function Dialog({
  label,
  onClose,
  className,
  children,
}: {
  label: string
  onClose: () => void
  className?: string
  children: (close: () => void) => ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [closing, setClosing] = useState(false)
  const closed = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Before paint, so the closed dialog never shows in the page flow.
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog || dialog.open) return
    dialog.showModal()
    // React's `autoFocus` fires while the dialog is still hidden, so it can't take focus; this mark can.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  const finish = useCallback(() => {
    if (closed.current) return
    closed.current = true
    onCloseRef.current()
  }, [])

  const close = useCallback(() => {
    if (closed.current) return
    setClosing(true)
    setTimeout(finish, exitMs)
  }, [finish])

  return (
    <dialog
      ref={ref}
      aria-label={label}
      data-closing={closing || undefined}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      // The browser can still force a close (a repeated Esc); follow it.
      onClose={finish}
      className="dialog m-auto max-h-[calc(100%-32px)] w-[calc(100%-32px)] max-w-md overflow-y-auto rounded-xl bg-popover p-5 text-popover-foreground shadow-lg"
    >
      <div className={cn('flex flex-col gap-4', className)}>{children(close)}</div>
    </dialog>
  )
}
