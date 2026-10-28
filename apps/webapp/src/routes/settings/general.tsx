import type { GeneralSettings } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/general')({
  component: General,
})

/** Settings → General: the owner's time zone. */
function General() {
  const [settings, setSettings] = useState<GeneralSettings>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api().general.getSettings().then(setSettings, (caught) => setError(errorMessage(caught)))
  }, [])

  async function chooseTimeZone(timeZone: string) {
    setError(undefined)
    try {
      setSettings(await api().general.updateSettings({ timeZone }))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-xl font-semibold">General</h2>
      </header>

      {error && <p className="text-destructive-foreground">{error}</p>}

      {settings && <TimeZoneField value={settings.timeZone} onChange={chooseTimeZone} />}
    </section>
  )
}

/** Every IANA time zone this browser knows, with its current UTC offset, e.g. `GMT+9`. */
function knownTimeZones(): { timeZone: string; offset: string }[] {
  const zones = new Set(Intl.supportedValuesOf('timeZone'))
  zones.add('UTC')
  return [...zones].sort().map((timeZone) => ({ timeZone, offset: offsetOf(timeZone) }))
}

/** `timeZone`'s UTC offset now, e.g. `GMT+9`; empty if this browser doesn't know it. */
function offsetOf(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date())
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** A searchable list of IANA time zones; choosing one saves it. */
function TimeZoneField({ value, onChange }: { value: string | null; onChange: (timeZone: string) => void }) {
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
      <label htmlFor="time-zone-search" className="text-lg font-medium">
        Time zone
      </label>
      <p className="text-sm text-muted-foreground">
        Routines and memory consolidation follow it. Currently{' '}
        <span className="font-medium text-foreground">{value ? `${value} (${offsetOf(value)})` : 'not set (UTC)'}</span>.
      </p>
      <input
        id="time-zone-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search, e.g. Paris or GMT+9"
        autoComplete="off"
        className="rounded-md border border-input bg-input-fill px-2.5 py-1.5 text-base outline-offset-0"
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
