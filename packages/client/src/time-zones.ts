/** An IANA time zone with its current UTC offset, e.g. `{ timeZone: 'Asia/Tokyo', offset: 'GMT+9' }`. */
export type KnownTimeZone = { timeZone: string; offset: string }

/**
 * Every IANA time zone in `names`, by name, with its current UTC offset: by default those this runtime knows. Hermes
 * can't list them, so the phone passes the instance's (`general.timeZones`).
 */
export function knownTimeZones(names: readonly string[] = Intl.supportedValuesOf('timeZone')): KnownTimeZone[] {
  const zones = new Set(names)
  zones.add('UTC')
  return [...zones].sort().map((timeZone) => ({ timeZone, offset: offsetOf(timeZone) }))
}

/** `timeZone`'s UTC offset now, e.g. `GMT+9`; empty if this runtime doesn't know it. */
export function offsetOf(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date())
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** The zones matching every word of `query` in their name (`_` read as a space) or offset, e.g. "paris" or "gmt+9". */
export function matchTimeZones(zones: readonly KnownTimeZone[], query: string): KnownTimeZone[] {
  const words = query.toLowerCase().replaceAll('_', ' ').split(/\s+/).filter(Boolean)
  return zones.filter((zone) => {
    const text = `${zone.timeZone} ${zone.offset}`.toLowerCase().replaceAll('_', ' ')
    return words.every((word) => text.includes(word))
  })
}
