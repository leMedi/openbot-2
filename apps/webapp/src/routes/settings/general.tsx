import { type GeneralSettings, maxOwnerAboutLength, maxOwnerNameLength } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Field, inputClass } from '../../components/bot-fields.tsx'
import { offsetOf, TimeZonePicker } from '../../components/time-zone-picker.tsx'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/general')({
  component: General,
})

/** Settings → General: who the owner is to their bots, and their time zone. */
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

      {settings && <ProfileForm settings={settings} onSaved={setSettings} />}

      {settings && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="time-zone-search" className="text-lg font-medium">
            Time zone
          </label>
          <p className="text-sm text-muted-foreground">
            Routines and memory consolidation follow it. Currently{' '}
            <span className="font-medium text-foreground">
              {settings.timeZone ? `${settings.timeZone} (${offsetOf(settings.timeZone)})` : 'not set (UTC)'}
            </span>
            .
          </p>
          <TimeZonePicker id="time-zone-search" value={settings.timeZone} onChange={chooseTimeZone} />
        </div>
      )}
    </section>
  )
}

/** The owner's name and description of themselves, which every bot reads; saved together. */
function ProfileForm({ settings, onSaved }: { settings: GeneralSettings; onSaved: (settings: GeneralSettings) => void }) {
  const [name, setName] = useState(settings.name ?? '')
  const [about, setAbout] = useState(settings.about)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const changed = name.trim() !== (settings.name ?? '') || about.trim() !== settings.about

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setSaving(true)
    try {
      onSaved(await api().general.updateProfile({ name: name.trim(), about: about.trim() }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <header>
        <h3 className="text-lg font-medium">About you</h3>
        <p className="text-sm text-muted-foreground">Every bot reads this before it works for you, from its next run.</p>
      </header>
      <Field label="Name" htmlFor="owner-name">
        <input id="owner-name" required maxLength={maxOwnerNameLength} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} />
      </Field>
      <Field label="About" htmlFor="owner-about">
        <textarea
          id="owner-about"
          rows={5}
          maxLength={maxOwnerAboutLength}
          placeholder="What you do, where you're based, how you like things done."
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          className={cn(inputClass, 'resize-y')}
        />
      </Field>
      {error && <p className="text-destructive-foreground">{error}</p>}
      <button
        type="submit"
        disabled={!changed || saving || !name.trim()}
        className="pressable self-end rounded-md bg-primary px-3 py-1.5 text-base text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
      >
        Save
      </button>
    </form>
  )
}
