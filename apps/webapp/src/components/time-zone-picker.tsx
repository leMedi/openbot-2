import { cn } from '@openbot/ui/lib/utils'
import { useMemo, useState } from 'react'
import { inputClass } from './bot-fields.tsx'

/** Every IANA time zone this browser knows, with its current UTC offset, e.g. `GMT+9`. */
function knownTimeZones(): { timeZone: string; offset: string }[] {
  const zones = new Set(Intl.supportedValuesOf('timeZone'))
  zones.add('UTC')
  return [...zones].sort().map((timeZone) => ({ timeZone, offset: offsetOf(timeZone) }))
}

/** `timeZone`'s UTC offset now, e.g. `GMT+9`; empty if this browser doesn't know it. */
export function offsetOf(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date())
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** The browser's own time zone, e.g. `Europe/Paris`; UTC if it has none. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** A searchable list of IANA time zones; `onChange` follows each choice. */
export function TimeZonePicker({
  id,
  value,
  onChange,
  autoFocus = false,
}: {
  id: string
  value: string | null
  onChange: (timeZone: string) => void
  autoFocus?: boolean
}) {
  const zones = useMemo(knownTimeZones, [])
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const words = query.toLowerCase().replaceAll('_', ' ').split(/\s+/).filter(Boolean)
    return zones.filter((zone) => {
      const text = `${zone.timeZone} ${zone.offset}`.toLowerCase().replaceAll('_', ' ')
      return words.every((word) => text.includes(word))
    })
  }, [zones, query])

  return (
    <div className="flex flex-col gap-1.5">
      <input
        id={id}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Enter picks the best match rather than submitting a form around the picker.
          if (event.key !== 'Enter') return
          event.preventDefault()
          if (matches[0]) onChange(matches[0].timeZone)
        }}
        placeholder="Search, e.g. Paris or GMT+9"
        autoComplete="off"
        autoFocus={autoFocus}
        className={inputClass}
      />
      <ul aria-label="Time zones" className="max-h-72 overflow-y-auto rounded-md border border-border-subtle">
        {matches.map((zone) => (
          <li key={zone.timeZone}>
            <button
              type="button"
              aria-pressed={zone.timeZone === value}
              onClick={() => onChange(zone.timeZone)}
              className={cn(
                'flex w-full justify-between px-2.5 py-1.5 text-left text-base transition-colors duration-100 hover:bg-secondary-hover active:bg-selected',
                zone.timeZone === value && 'bg-selected',
              )}
            >
              <span>{zone.timeZone.replaceAll('_', ' ')}</span>
              <span className="text-muted-foreground">{zone.offset}</span>
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className="px-2.5 py-1.5 text-muted-foreground">No time zone matches.</li>}
      </ul>
    </div>
  )
}
