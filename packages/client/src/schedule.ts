import cronstrue from 'cronstrue'

/** A quarter-hour time of day, `HH:MM`. */
export type TimeOfDay = string

/** The aliases the server takes; `@midnight` is `@daily`, `@annually` is `@yearly`. */
export const scheduleAliases = ['@hourly', '@daily', '@midnight', '@weekly', '@monthly', '@yearly', '@annually'] as const
export type ScheduleAlias = (typeof scheduleAliases)[number]

export type EveryUnit = 'm' | 'h' | 'd'

/**
 * A routine's schedule as the editor shows it (design §5.4): a quarter-hour time every day, on weekdays, on one weekday
 * or on one day of the month; an alias; every so long; once, at a local date and time (`YYYY-MM-DDTHH:MM`); or any
 * other expression, as custom cron. Times are the owner's.
 */
export type ScheduleForm =
  | { kind: 'daily' | 'weekdays'; time: TimeOfDay }
  | { kind: 'weekly'; weekday: number; time: TimeOfDay }
  | { kind: 'monthly'; day: number; time: TimeOfDay }
  | { kind: 'alias'; alias: ScheduleAlias }
  | { kind: 'every'; amount: number; unit: EveryUnit }
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string }

export type ScheduleKind = ScheduleForm['kind']

const pad = (value: number) => String(value).padStart(2, '0')

/** The 96 quarter-hour times of a day, the time picker's choices. */
export const quarterHours: TimeOfDay[] = Array.from({ length: 96 }, (_, index) => `${pad(Math.floor(index / 4))}:${pad((index % 4) * 15)}`)

/** A plain number in `min`–`max` written as cron writes it (no leading zeros), else undefined. */
function plainNumber(text: string, min: number, max: number): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(text)) return undefined
  const value = Number(text)
  return value >= min && value <= max ? value : undefined
}

/** `text`, a schedule the API takes, as the editor shows it; whatever the presets can't show is custom cron. */
export function scheduleForm(text: string): ScheduleForm {
  const trimmed = text.trim()
  const custom: ScheduleForm = { kind: 'cron', expression: trimmed }
  const alias = scheduleAliases.find((entry) => entry === trimmed.toLowerCase())
  if (alias) return { kind: 'alias', alias }
  const every = /^@every\s+([1-9]\d*)([mhd])$/.exec(trimmed)
  if (every) return { kind: 'every', amount: Number(every[1]), unit: every[2] as EveryUnit }
  const once = /^at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/.exec(trimmed)
  if (once) return { kind: 'once', at: once[1]! }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return custom
  const [minuteText, hourText, day, month, weekday] = parts as [string, string, string, string, string]
  const minute = plainNumber(minuteText, 0, 59)
  const hour = plainNumber(hourText, 0, 23)
  if (minute === undefined || hour === undefined || minute % 15 !== 0 || month !== '*') return custom
  const time = `${pad(hour)}:${pad(minute)}`
  if (day === '*' && weekday === '*') return { kind: 'daily', time }
  if (day === '*' && weekday === '1-5') return { kind: 'weekdays', time }
  const weekdayNumber = plainNumber(weekday, 0, 6)
  if (day === '*' && weekdayNumber !== undefined) return { kind: 'weekly', weekday: weekdayNumber, time }
  const dayNumber = plainNumber(day, 1, 31)
  if (weekday === '*' && dayNumber !== undefined) return { kind: 'monthly', day: dayNumber, time }
  return custom
}

/** The schedule `form` stands for, as the API takes it. */
export function scheduleText(form: ScheduleForm): string {
  const at = (time: TimeOfDay) => {
    const [hour, minute] = time.split(':').map(Number)
    return `${minute} ${hour}`
  }
  switch (form.kind) {
    case 'daily':
      return `${at(form.time)} * * *`
    case 'weekdays':
      return `${at(form.time)} * * 1-5`
    case 'weekly':
      return `${at(form.time)} * * ${form.weekday}`
    case 'monthly':
      return `${at(form.time)} ${form.day} * *`
    case 'alias':
      return form.alias
    case 'every':
      return `@every ${form.amount}${form.unit}`
    case 'once':
      return `at ${form.at}`
    case 'cron':
      return form.expression.trim()
  }
}

export const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const unitNames: Record<EveryUnit, string> = { m: 'minute', h: 'hour', d: 'day' }

/** `time` as a clock shows it, e.g. `9:30 AM`. */
export function clockTime(time: TimeOfDay): string {
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`
}

/** `day` as an ordinal: 1st, 2nd, 3rd, 11th, 22nd. */
function ordinal(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'
  return `${day}${suffix}`
}

/**
 * `text`, a schedule, as a sentence (Grok's "Every day at 9:00 AM"): the presets, `@every` and a one-off in our words,
 * aliases and custom cron as cronstrue reads them; undefined for something that isn't a 5-field cron expression.
 */
export function describeSchedule(text: string): string | undefined {
  const form = scheduleForm(text)
  switch (form.kind) {
    case 'daily':
      return `Every day at ${clockTime(form.time)}`
    case 'weekdays':
      return `On weekdays at ${clockTime(form.time)}`
    case 'weekly':
      return `Every ${weekdayNames[form.weekday]} at ${clockTime(form.time)}`
    case 'monthly':
      return `Monthly on the ${ordinal(form.day)} at ${clockTime(form.time)}`
    case 'every':
      return form.amount === 1 ? `Every ${unitNames[form.unit]}` : `Every ${form.amount} ${unitNames[form.unit]}s`
    case 'once': {
      const [date, time] = form.at.split('T') as [string, string]
      const day = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      return `Once, on ${day} at ${clockTime(time)}`
    }
    case 'alias':
    case 'cron': {
      const expression = form.kind === 'alias' ? aliasExpressions[form.alias] : scheduleText(form)
      if (expression.split(/\s+/).length !== 5) return undefined
      try {
        return cronstrue.toString(expression, { verbose: false, use24HourTimeFormat: false })
      } catch {
        return undefined
      }
    }
  }
}

const aliasExpressions: Record<ScheduleAlias, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

/** The time of day `form` names, if any. */
function timeOf(form: ScheduleForm): TimeOfDay | undefined {
  if (form.kind === 'once') return form.at.split('T')[1]
  return 'time' in form ? form.time : undefined
}

/**
 * `form` as a schedule of another kind, for the editor's kind picker: its time of day carries over (9:00 AM where it
 * had none), a one-off falls on `date` (`YYYY-MM-DD`) to start with, and custom cron starts from the
 * expression it was.
 */
export function switchKind(form: ScheduleForm, kind: ScheduleKind, date: string): ScheduleForm {
  if (form.kind === kind) return form
  const time = timeOf(form) ?? '09:00'
  switch (kind) {
    case 'daily':
    case 'weekdays':
      return { kind, time }
    case 'weekly':
      return { kind, weekday: 1, time }
    case 'monthly':
      return { kind, day: 1, time }
    case 'alias':
      return { kind, alias: '@hourly' }
    case 'every':
      return { kind, amount: 30, unit: 'm' }
    case 'once':
      return { kind, at: `${date}T${time}` }
    case 'cron':
      if (form.kind === 'alias') return { kind, expression: aliasExpressions[form.alias] }
      if (form.kind === 'every' || form.kind === 'once') return { kind, expression: scheduleText({ kind: 'daily', time }) }
      return { kind, expression: scheduleText(form) }
  }
}
