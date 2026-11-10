import { useEffect, useRef } from 'react'

/** Calls `done` each time `working` goes from true to false (a bot finished a run), not when it starts out false. */
export function useWhenDone(working: boolean | undefined, done: () => void) {
  const was = useRef(working)
  useEffect(() => {
    if (was.current && working === false) done()
    was.current = working
  }, [working, done])
}
