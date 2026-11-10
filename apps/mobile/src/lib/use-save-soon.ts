import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

/** How long typing pauses before what was typed is saved. */
const pauseMs = 800

/**
 * Saves text as the owner types, as the sketch's "Changes save as you type": `soon` after each change saves once typing
 * pauses, `now` (when the field is left) saves at once, and leaving the screen saves what's pending. Android doesn't
 * end editing when the keyboard is hidden or a button is tapped, so saving on blur alone would lose text there.
 * `save` gets `final`: false while the owner may still be typing (so an emptied field isn't put back yet).
 */
export function useSaveSoon(save: (final: boolean) => void): { soon: () => void; now: () => void; cancel: () => void } {
  const latest = useRef(save)
  useLayoutEffect(() => {
    latest.current = save
  })
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const now = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    latest.current(true)
  }, [])
  const soon = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = undefined
      latest.current(false)
    }, pauseMs)
  }, [])
  /** Drops what's pending, e.g. as what it would save is deleted. */
  const cancel = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  useEffect(
    () => () => {
      if (timer.current !== undefined) now()
    },
    [now],
  )
  return { soon, now, cancel }
}
