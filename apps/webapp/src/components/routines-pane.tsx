import type { BotInfo, NewRoutine, RoutineChanges, RoutineInfo, RoutineRunInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { useLiveEvents } from '../lib/live.tsx'
import { applyRoutineEvent, applyRunEvent, sortRoutines } from '../lib/routines.ts'
import {
  clockTime,
  describeSchedule,
  type EveryUnit,
  quarterHours,
  scheduleAliases,
  type ScheduleForm,
  scheduleForm,
  type ScheduleKind,
  scheduleText,
  switchKind,
  weekdayNames,
} from '../lib/schedule.ts'
import { inputClass } from './bot-fields.tsx'
import { ConfirmDeleteRoutine } from './confirm-delete.tsx'

/** A new routine runs every day at 9:00 AM until the owner picks another schedule. */
const defaultSchedule = '0 9 * * *'

/** A routine to open in the pane, e.g. from a timeline row's clock chip; a new request each time, even for the same one. */
export type RoutineToOpen = { routineId: string; requestedAt: number }

/** What the pane shows: the list, a routine, or a routine the owner is creating. */
type View = { name: 'list' } | { name: 'routine'; routineId: string } | { name: 'new' }

/**
 * Grok Bot's Routines pane (design §5.4): the bot's routines, active first, and one routine's detail, where the owner
 * edits, pauses, deletes and test-runs it and sees its run history. Everything saves on blur; Esc goes back to the
 * list. It follows the live events, and reads everything anew after missing some. Keyed by bot: another bot's
 * routines start from its list.
 */
export function RoutinesPane({ bot, open, onClose }: { bot: BotInfo; open?: RoutineToOpen; onClose: () => void }) {
  const [routines, setRoutines] = useState<RoutineInfo[]>()
  const [error, setError] = useState<string>()
  const [view, setView] = useState<View>(open ? { name: 'routine', routineId: open.routineId } : { name: 'list' })
  const [reloads, setReloads] = useState(0)
  const timeZone = useTimeZone()
  const botId = bot.id

  useEffect(() => {
    let current = true
    api()
      .routines.list({ botId })
      .then((loaded) => {
        if (!current) return
        setRoutines(loaded)
        setError(undefined)
      })
      .catch((caught) => current && setError(errorMessage(caught)))
    return () => {
      current = false
    }
  }, [botId, reloads])

  useEffect(() => {
    if (open) setView({ name: 'routine', routineId: open.routineId })
  }, [open])

  useLiveEvents((event) => {
    if (event.type === 'hello' && !event.resumed) return setReloads((count) => count + 1)
    setRoutines((current) => applyRoutineEvent(current, botId, event))
  })

  const shown = routines
  const opened = view.name === 'routine' ? shown?.find((routine) => routine.id === view.routineId) : undefined
  // A routine deleted meanwhile, or never there (a chip of one since deleted), leaves the list showing.
  const showsList = view.name === 'list' || (view.name === 'routine' && shown !== undefined && !opened)

  function back() {
    // Saves the field being edited, on its blur.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setView({ name: 'list' })
  }

  // Esc goes back to the list, wherever the focus is, unless a dialog or menu takes it or the owner types elsewhere.
  const pane = useRef<HTMLElement>(null)
  const backOnEscape = useRef<(() => void) | undefined>(undefined)
  backOnEscape.current = showsList ? undefined : back
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !backOnEscape.current) return
      const target = event.target instanceof Element ? event.target : undefined
      if (target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]')) return
      if (target?.matches('input, textarea, select, [contenteditable="true"]') && !pane.current?.contains(target)) return
      event.preventDefault()
      backOnEscape.current()
    }
    addEventListener('keydown', onKeyDown)
    return () => removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <aside
      ref={pane}
      aria-label={`${bot.name}'s routines`}
      className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle p-5"
    >
      <header className="flex items-center gap-1">
        {!showsList && (
          <button type="button" aria-label="Back to routines" onClick={back} className="pressable -ml-1.5 rounded-md p-1.5 hover:bg-secondary-hover">
            <BackIcon />
          </button>
        )}
        <h2 className="text-lg font-semibold">Routines</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="pressable -mr-1.5 ml-auto rounded-md p-1.5 hover:bg-secondary-hover">
          <CloseIcon />
        </button>
      </header>
      {error && <p className="text-sm text-destructive-foreground">Couldn't load {bot.name}'s routines: {error}</p>}
      {shown && showsList && <RoutineList botName={bot.name} routines={shown} onOpen={(routineId) => setView({ name: 'routine', routineId })} onCreate={() => setView({ name: 'new' })} />}
      {opened && <RoutineDetail key={opened.id} routine={opened} timeZone={timeZone} onDeleted={() => setView({ name: 'list' })} />}
      {view.name === 'new' && (
        <NewRoutineDetail
          botId={botId}
          timeZone={timeZone}
          onCreated={(created) => {
            // While the list loads, the new routine comes with it.
            setRoutines((current) => applyRoutineEvent(current, botId, { type: 'routine.updated', routine: created }))
            setView((current) => (current.name === 'new' ? { name: 'routine', routineId: created.id } : current))
          }}
          onDiscard={() => setView({ name: 'list' })}
        />
      )}
    </aside>
  )
}

/** The owner's time zone, which routines follow; undefined until known. */
function useTimeZone(): string | undefined {
  const [timeZone, setTimeZone] = useState<string>()
  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    let current = true
    api()
      .general.getSettings()
      .then((settings) => current && setTimeZone(settings.timeZone ?? undefined))
      // Unknown, times read "in your time zone"; the pane's own loads show what failed.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [reloads])
  useLiveEvents((event) => {
    if (event.type === 'hello' && !event.resumed) setReloads((count) => count + 1)
    if (event.type === 'timeZone.updated') setTimeZone(event.timeZone)
  })
  return timeZone
}

/** The routines, active first: each with its icon, name, and schedule in words or "Paused". */
function RoutineList({ botName, routines, onOpen, onCreate }: { botName: string; routines: RoutineInfo[]; onOpen: (routineId: string) => void; onCreate: () => void }) {
  if (!routines.length) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">Routines wake {botName} on a schedule to follow an instruction, such as sending you a morning digest.</p>
        <CreateButton onClick={onCreate} />
      </div>
    )
  }
  return (
    <>
      <ul className="-mx-2 flex flex-col">
        {sortRoutines(routines).map((routine) => (
          <li key={routine.id}>
            <button type="button" onClick={() => onOpen(routine.id)} className="pressable flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-secondary-hover">
              <RoutineIcon routine={routine} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{routine.name}</span>
                <span className="truncate text-sm text-muted-foreground">{routine.enabled ? (describeSchedule(routine.schedule) ?? routine.schedule) : 'Paused'}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        <CreateButton onClick={onCreate} />
      </div>
    </>
  )
}

function CreateButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="pressable rounded-md bg-primary px-3 py-1.5 text-base text-primary-foreground hover:bg-primary-hover">
      Create Routine
    </button>
  )
}

/** A clock, a spinner while it runs, or a pause sign while it's paused. */
function RoutineIcon({ routine }: { routine: RoutineInfo }) {
  if (routine.running) return <Spinner label="Running" />
  if (!routine.enabled) return <PauseIcon />
  return <ClockIcon />
}

type SaveStatus = { saving: boolean; error?: string }

/** "Saving…" while a change is on its way, or what failed and why; nothing otherwise. */
function SaveStatusLine({ status }: { status: SaveStatus }) {
  if (!status.saving && !status.error) return null
  return (
    <p role="status" className={cn('text-sm', status.error ? 'text-destructive-foreground' : 'text-muted-foreground')}>
      {status.error ?? 'Saving…'}
    </p>
  )
}

/**
 * One routine: Active, Delete and Test run, its name, instruction and schedule, which save on blur, and its run history.
 * Changes are sent one after another, so they land in the order the owner made them; a field the owner is editing
 * keeps what they typed while the routine changes elsewhere.
 */
function RoutineDetail({ routine, timeZone, onDeleted }: { routine: RoutineInfo; timeZone: string | undefined; onDeleted: () => void }) {
  const [status, setStatus] = useState<SaveStatus>({ saving: false })
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [starting, setStarting] = useState(false)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const ids = { botId: routine.botId, routineId: routine.id }

  /** Sends `work` after the changes before it; whether it succeeded, else why not, after `failed`. */
  function run(work: () => Promise<unknown>, failed = "Couldn't save"): Promise<boolean> {
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
    queue.current = done.then(() => {})
    return done
  }

  // The answer arrives as `routine.updated` too, which shows it.
  const save = (changes: RoutineChanges) => run(() => api().routines.update({ ...ids, ...changes }))

  async function testRun() {
    setStarting(true)
    await run(() => api().routines.testRun(ids), "Couldn't start a test run")
    setStarting(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={routine.enabled}
            onChange={(event) => {
              const active = event.target.checked
              run(() => (active ? api().routines.resume(ids) : api().routines.pause(ids)))
            }}
          />
          Active
        </label>
        <button type="button" onClick={() => setConfirmingDelete(true)} className="ml-auto rounded-md px-2 py-1 text-sm text-destructive-foreground hover:bg-secondary-hover">
          Delete
        </button>
        <button
          type="button"
          disabled={routine.running || starting}
          onClick={() => void testRun()}
          className="pressable rounded-md bg-secondary px-2.5 py-1 text-sm hover:bg-secondary-hover disabled:opacity-60"
        >
          {routine.running || starting ? 'Running…' : 'Test run'}
        </button>
      </div>
      <SaveStatusLine status={status} />
      <TextField label="Name" placeholder="Name this routine" value={routine.name} onSave={(name) => save({ name })} />
      <TextField label="Instruction" placeholder="What should this routine do each time it runs?" value={routine.prompt} multiline onSave={(prompt) => save({ prompt })} />
      <ScheduleField schedule={routine.schedule} timeZone={timeZone} onSave={(schedule) => save({ schedule })} />
      {routine.enabled && routine.nextRunAt !== null && (
        <p className="-mt-2 text-sm text-muted-foreground">Next run {formatInstant(routine.nextRunAt, timeZone)}</p>
      )}
      <RunHistory routine={routine} timeZone={timeZone} />
      {confirmingDelete && <ConfirmDeleteRoutine routine={routine} onCancel={() => setConfirmingDelete(false)} onDeleted={onDeleted} />}
    </div>
  )
}

/**
 * A routine the owner is creating: created, with Active as they left it, once its name and instruction are filled in
 * and a field loses focus. Delete drops it.
 */
function NewRoutineDetail({
  botId,
  timeZone,
  onCreated,
  onDiscard,
}: {
  botId: string
  timeZone: string | undefined
  onCreated: (routine: RoutineInfo) => void
  onDiscard: () => void
}) {
  const [draft, setDraft] = useState<NewRoutine>({ name: '', prompt: '', schedule: defaultSchedule, enabled: true })
  const [status, setStatus] = useState<SaveStatus>({ saving: false })
  const creating = useRef(false)
  // The draft as last edited, also while it's being created.
  const latest = useRef(draft)

  async function create(values: NewRoutine) {
    setDraft(values)
    latest.current = values
    if (creating.current || !values.name.trim() || !values.prompt.trim()) return
    creating.current = true
    setStatus({ saving: true })
    let created: RoutineInfo
    try {
      created = await api().routines.create({ botId, ...values })
    } catch (caught) {
      creating.current = false
      setStatus({ saving: false, error: `Couldn't create it: ${errorMessage(caught)}` })
      return
    }
    // Edited while it was being created: those edits follow, best effort; the routine shows as saved either way.
    const edited = latest.current
    const ids = { botId, routineId: created.id }
    try {
      if (edited.name !== values.name || edited.prompt !== values.prompt || edited.schedule !== values.schedule) {
        created = await api().routines.update({ ...ids, name: edited.name, prompt: edited.prompt, schedule: edited.schedule })
      }
      if (edited.enabled !== values.enabled) created = await (edited.enabled ? api().routines.resume(ids) : api().routines.pause(ids))
    } catch {
      // Shown as it was created.
    }
    onCreated(created)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => void create({ ...draft, enabled: event.target.checked })} />
          Active
        </label>
        <button type="button" onClick={onDiscard} className="ml-auto rounded-md px-2 py-1 text-sm text-destructive-foreground hover:bg-secondary-hover">
          Delete
        </button>
        <button type="button" disabled className="rounded-md bg-secondary px-2.5 py-1 text-sm disabled:opacity-60">
          Test run
        </button>
      </div>
      <SaveStatusLine status={status} />
      <TextField label="Name" placeholder="Name this routine" value={draft.name} autoFocus onSave={(name) => void create({ ...draft, name })} />
      <TextField
        label="Instruction"
        placeholder="What should this routine do each time it runs?"
        value={draft.prompt}
        multiline
        onSave={(prompt) => void create({ ...draft, prompt })}
      />
      <ScheduleField schedule={draft.schedule} timeZone={timeZone} onSave={(schedule) => void create({ ...draft, schedule })} />
      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium">Run history</h3>
        <p className="text-sm text-muted-foreground">No runs yet</p>
      </section>
    </div>
  )
}

/** A labelled text field that saves on blur when changed; emptied, it shows the saved text again. */
function TextField({
  label,
  placeholder,
  value,
  multiline,
  autoFocus,
  onSave,
}: {
  label: string
  placeholder: string
  value: string
  multiline?: boolean
  autoFocus?: boolean
  onSave: (value: string) => void
}) {
  const [text, setText] = useState(value)
  const editing = useRef(false)
  // Changed elsewhere, e.g. by the bot: show it as it is, unless the owner is typing.
  useEffect(() => {
    if (!editing.current) setText(value)
  }, [value])
  const props = {
    'aria-label': label,
    placeholder,
    value: text,
    autoFocus,
    onFocus: () => (editing.current = true),
    onChange: (event: { target: { value: string } }) => setText(event.target.value),
    onBlur: () => {
      editing.current = false
      const trimmed = text.trim()
      if (!trimmed && value) return setText(value)
      if (trimmed !== value.trim()) onSave(trimmed)
    },
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      {multiline ? <textarea rows={4} {...props} className={cn(inputClass, 'resize-y')} /> : <input type="text" {...props} className={inputClass} />}
    </label>
  )
}

const kindLabels: Record<ScheduleKind, string> = {
  daily: 'Every day',
  weekdays: 'On weekdays',
  weekly: 'Every week',
  monthly: 'Every month',
  alias: 'Preset',
  every: 'Every so often',
  once: 'Once',
  cron: 'Custom cron',
}

const unitLabels: Record<EveryUnit, string> = { m: 'minutes', h: 'hours', d: 'days' }

/** `instant`'s date in `timeZone`, `YYYY-MM-DD`. */
function localDate(instant: number, timeZone: string | undefined): string {
  return new Date(instant).toLocaleDateString('en-CA', { timeZone })
}

/**
 * "When to run": what kind of schedule (a quarter-hour time every day, on weekdays, weekly or monthly; a preset alias;
 * every so often; once; or custom cron) and its details, with the schedule in words below. Pickers save at once, typed
 * values on blur.
 */
function ScheduleField({
  schedule,
  timeZone,
  onSave,
}: {
  schedule: string
  timeZone: string | undefined
  /** Saves it; false when the server refused it, which shows the saved schedule again. */
  onSave: (schedule: string) => Promise<boolean> | void
}) {
  const [form, setForm] = useState(() => scheduleForm(schedule))
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setForm(scheduleForm(schedule))
  }, [schedule])
  const sentence = describeSchedule(scheduleText(form))

  function commit(next: ScheduleForm) {
    setForm(next)
    const text = scheduleText(next)
    if (!text || text === schedule.trim()) return
    void Promise.resolve(onSave(text)).then((saved) => {
      if (saved === false && !editing.current) setForm(scheduleForm(schedule))
    })
  }
  // Typing: shown at once, saved on blur.
  const typing = (next: ScheduleForm) => {
    editing.current = true
    setForm(next)
  }
  const blur = () => {
    editing.current = false
    commit(form)
  }
  const select = (label: string, value: string | number, options: [string | number, string][], change: (value: string) => void) => (
    <select aria-label={label} value={value} onChange={(event) => change(event.target.value)} className={inputClass}>
      {options.map(([option, text]) => (
        <option key={option} value={option}>
          {text}
        </option>
      ))}
    </select>
  )
  const timeSelect = (time: string, change: (time: string) => void) =>
    select(
      'Time',
      time,
      (quarterHours.includes(time) ? quarterHours : [time, ...quarterHours]).map((entry) => [entry, clockTime(entry)]),
      change,
    )

  let details: ReactNode
  switch (form.kind) {
    case 'daily':
    case 'weekdays':
      details = timeSelect(form.time, (time) => commit({ ...form, time }))
      break
    case 'weekly':
      details = (
        <>
          {select('Day of the week', form.weekday, weekdayNames.map((name, index) => [index, name]), (weekday) => commit({ ...form, weekday: Number(weekday) }))}
          {timeSelect(form.time, (time) => commit({ ...form, time }))}
        </>
      )
      break
    case 'monthly':
      details = (
        <>
          {select('Day of the month', form.day, Array.from({ length: 31 }, (_, index) => [index + 1, `Day ${index + 1}`]), (day) => commit({ ...form, day: Number(day) }))}
          {timeSelect(form.time, (time) => commit({ ...form, time }))}
        </>
      )
      break
    case 'alias':
      details = select('Preset', form.alias, scheduleAliases.map((alias) => [alias, alias]), (alias) => commit({ ...form, alias: alias as typeof form.alias }))
      break
    case 'every':
      details = (
        <>
          <input
            type="number"
            aria-label="How many"
            min={1}
            value={form.amount}
            onChange={(event) => typing({ ...form, amount: Math.max(1, Math.floor(Number(event.target.value)) || 1) })}
            onBlur={blur}
            className={cn(inputClass, 'w-20')}
          />
          {select('Unit', form.unit, Object.entries(unitLabels), (unit) => commit({ ...form, unit: unit as EveryUnit }))}
        </>
      )
      break
    case 'once':
      details = (
        <input
          type="datetime-local"
          aria-label="Date and time"
          value={form.at}
          onChange={(event) => event.target.value && typing({ ...form, at: event.target.value.slice(0, 16) })}
          onBlur={blur}
          className={inputClass}
        />
      )
      break
    case 'cron':
      details = (
        <input
          type="text"
          aria-label="Cron expression"
          placeholder="minute hour day month weekday"
          spellCheck={false}
          value={form.expression}
          onChange={(event) => typing({ ...form, expression: event.target.value })}
          onBlur={blur}
          className={cn(inputClass, 'w-full font-mono')}
        />
      )
  }

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 font-medium">When to run</legend>
      <div className="flex flex-col gap-2 rounded-md bg-secondary p-3">
        <div className="flex flex-wrap gap-2">
          {select('Repeat', form.kind, Object.entries(kindLabels), (kind) =>
            commit(switchKind(form, kind as ScheduleKind, localDate(Date.now() + 24 * 60 * 60 * 1000, timeZone))),
          )}
          {details}
        </div>
        <p className={cn('text-sm', sentence ? 'text-foreground' : 'text-destructive-foreground')}>{sentence ?? 'Not a valid schedule.'}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Times are in {timeZone ?? 'your time zone'}.{' '}
        <Link to="/settings/general" className="text-link hover:underline">
          Change
        </Link>
      </p>
    </fieldset>
  )
}

/** `instant` as a date and time in `timeZone`, e.g. "Thu, Oct 29, 9:00 AM". */
function formatInstant(instant: number, timeZone: string | undefined): string {
  return new Date(instant).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone })
}

const runOutcomes: Record<Exclude<RoutineRunInfo['status'], 'running'>, { mark: string; label: string; className: string }> = {
  ran: { mark: '✓', label: 'Ran', className: 'text-green-foreground' },
  failed: { mark: '✗', label: 'Failed', className: 'text-destructive-foreground' },
  skipped_overlap: { mark: 'Skipped', label: 'Skipped: the previous run was still going', className: 'text-xs text-muted-foreground' },
  missed: { mark: 'Missed', label: 'Missed while the server was down', className: 'text-xs text-muted-foreground' },
}

/** The routine's runs, newest first, kept up to date live: when each was due, and how it went. */
function RunHistory({ routine, timeZone }: { routine: RoutineInfo; timeZone: string | undefined }) {
  const [runs, setRuns] = useState<RoutineRunInfo[]>()
  const [error, setError] = useState<string>()
  const [reloads, setReloads] = useState(0)
  const { botId, id: routineId } = routine

  useEffect(() => {
    let current = true
    api()
      .routines.runs({ botId, routineId })
      .then((loaded) => current && (setRuns(loaded), setError(undefined)))
      .catch((caught) => current && setError(errorMessage(caught)))
    return () => {
      current = false
    }
  }, [botId, routineId, reloads])

  useLiveEvents((event) => {
    if (event.type === 'hello' && !event.resumed) return setReloads((count) => count + 1)
    setRuns((current) => applyRunEvent(current, routineId, event))
  })

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-medium">Run history</h3>
      {error && <p className="text-sm text-destructive-foreground">Couldn't load its runs: {error}</p>}
      {runs && !runs.length && <p className="text-sm text-muted-foreground">No runs yet</p>}
      {runs && runs.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {runs.map((run) => (
            <li key={run.id} className="flex items-center gap-2">
              <time dateTime={new Date(run.scheduledFor).toISOString()} className="tabular-nums">
                {formatInstant(run.scheduledFor, timeZone)}
              </time>
              {run.test && <span className="rounded bg-secondary px-1 text-xs text-muted-foreground">Test</span>}
              {run.message && <span className="text-xs text-muted-foreground">messaged you</span>}
              <span className="ml-auto">
                {run.status === 'running' ? (
                  <Spinner label="Running" />
                ) : (
                  <span role="img" aria-label={runOutcomes[run.status].label} title={runOutcomes[run.status].label} className={cn('font-medium', runOutcomes[run.status].className)}>
                    {runOutcomes[run.status].mark}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const iconProps = { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function ClockIcon() {
  return (
    <svg {...iconProps} aria-hidden className="shrink-0 text-muted-foreground">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg {...iconProps} role="img" aria-label="Paused" className="shrink-0 text-muted-foreground">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.5 5.75v4.5M9.5 5.75v4.5" />
    </svg>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <svg {...iconProps} role="img" aria-label={label} className="inline-block shrink-0 text-muted-foreground motion-safe:animate-spin">
      <path d="M8 1.75A6.25 6.25 0 1 1 1.75 8" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg {...iconProps} aria-hidden>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg {...iconProps} aria-hidden>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  )
}
