// Word error rate against the passage the owner read: (substitutions + deletions + insertions) / reference words, after
// lowercasing, splitting elisions (l'agent → l agent) and dropping punctuation. Rough by design: misreadings by the
// speaker count against the model, so read the transcripts too.

export function words(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/['-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export function wer(reference: string, hypothesis: string): number {
  const ref = words(reference)
  const hyp = words(hypothesis)
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const current = [i]
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[hyp.length] / ref.length
}
