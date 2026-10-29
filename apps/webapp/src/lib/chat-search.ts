/** What the palette opens a chat on: a message to scroll to, or (in a DM) a routine to show in the Routines pane. */
export type ChatSearch = { message?: string; routine?: string }

/** A chat route's search params, keeping only those it understands. */
export function chatSearch(search: Record<string, unknown>): ChatSearch {
  return {
    ...(typeof search.message === 'string' && { message: search.message }),
    ...(typeof search.routine === 'string' && { routine: search.routine }),
  }
}
