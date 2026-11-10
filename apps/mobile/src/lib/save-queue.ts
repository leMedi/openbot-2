import { useRef, useState } from 'react'
import { errorMessage } from './errors.ts'

/** Whether a change is on its way, or what the last one's failure said in full (e.g. "Couldn't save: …"). */
export type SaveStatus = { saving: boolean; error?: string }

/** "Saving…" while a change is on its way, or what failed; `idle` otherwise. */
export function statusNote(status: SaveStatus, idle: string): string {
  return status.error ?? (status.saving ? 'Saving…' : idle)
}

/**
 * Runs changes one after another, so they land in the order the owner made them, with their status: `run` resolves to
 * whether the change worked; a failure's status reads `failed` and why.
 */
export function useSaveQueue(): { status: SaveStatus; run: (work: () => Promise<unknown>, failed?: string) => Promise<boolean>; setStatus: (status: SaveStatus) => void } {
  const [status, setStatus] = useState<SaveStatus>({ saving: false })
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const run = (work: () => Promise<unknown>, failed = "Couldn't save") => {
    setStatus({ saving: true })
    const done = queue.current.then(async () => {
      try {
        await work()
        setStatus({ saving: false })
        return true
      } catch (caught) {
        setStatus({ saving: false, error: `${failed}: ${errorMessage(caught)}` })
        return false
      }
    })
    queue.current = done
    return done
  }
  return { status, run, setStatus }
}
