/** Where the cursor is in the composer's field, or what's selected there. */
export type Selection = { start: number; end: number }

/**
 * The draft with dictated `spoken` text put at the cursor (replacing a selection), with a space before it when it
 * follows other text and after it when text follows, and where the cursor goes: just after it.
 */
export function insertDictation(draft: string, selection: Selection, spoken: string): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(selection.start, selection.end, draft.length))
  const end = Math.min(Math.max(selection.start, selection.end), draft.length)
  const before = draft.slice(0, start)
  const after = draft.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  // Before a word, not before punctuation or a space.
  const trail = /^[\p{L}\p{N}]/u.test(after) ? ' ' : ''
  const inserted = lead + spoken + trail
  return { text: before + inserted + after, cursor: before.length + inserted.length }
}

// Markers a speech model writes for what isn't speech: anything in square brackets ([BLANK_AUDIO], [Music]), and a
// few in parentheses, which could otherwise be dictated words.
const nonSpeech = /\[[^\]]*\]|\((?:silence|music|noise|inaudible|blank audio|laughs?|applause)\)/gi

/** The words in a transcript, without the engine's non-speech markers: empty when nothing was said. */
export function heardText(transcript: string): string {
  return transcript.replace(nonSpeech, ' ').replace(/\s+/g, ' ').trim()
}
