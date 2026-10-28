import { instantOfWall, type LocalDateTime, offsetAt, parseLocalDateTime } from './server-jobs.ts'

/** A schedule a routine can't have; its message says why. */
export class InvalidScheduleError extends Error {}

/** `@every` is at least this long. */
export const minEveryMs = 5 * 60 * 1000

/**
 * When a routine fires (design §5.4): a 5-field cron expression (an alias such as `@daily` is one), every so long
 * (`@every 15m`), or once, at a local date and time (`at 2026-10-29T09:00`, a reminder). Cron and `at` read the owner's
 * time zone; `@every` doesn't.
 */
export type Schedule =
  | { kind: 'cron'; minutes: ReadonlySet<number>; hours: ReadonlySet<number>; days: ReadonlySet<number>; months: ReadonlySet<number>; weekdays: ReadonlySet<number>; anyDay: boolean; anyWeekday: boolean }
  | { kind: 'every'; ms: number }
  | { kind: 'at'; local: LocalDateTime }

const aliases: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const weekdayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

type Field = { name: string; min: number; max: number; names?: string[]; namesFrom?: number }

const fields: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: monthNames, namesFrom: 1 },
  // 7 is Sunday too.
  { name: 'day of week', min: 0, max: 7, names: weekdayNames, namesFrom: 0 },
]

/** The values one cron field allows: `*`, `5`, `1-5`, `*\/15`, `1-30/5`, names, and lists of those. */
function parseField(text: string, field: Field): Set<number> {
  const invalid = () => new InvalidScheduleError(`${JSON.stringify(text)} isn't a valid ${field.name} (${field.min}–${field.max})`)
  const value = (token: string) => {
    const named = field.names?.indexOf(token.toUpperCase()) ?? -1
    if (named !== -1) return named + field.namesFrom!
    if (!/^\d+$/.test(token)) throw invalid()
    const number = Number(token)
    if (number < field.min || number > field.max) throw invalid()
    return number
  }
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const [range, stepText, ...extra] = part.split('/')
    if (extra.length || !range) throw invalid()
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw new InvalidScheduleError(`${JSON.stringify(part)} needs a step of at least 1`)
      step = Number(stepText)
    }
    let from: number
    let to: number
    if (range === '*') [from, to] = [field.min, field.max]
    else if (range.includes('-')) {
      const [start, end, ...more] = range.split('-')
      if (more.length || !start || !end) throw invalid()
      ;[from, to] = [value(start), value(end)]
      if (from > to) throw invalid()
    } else {
      from = value(range)
      to = stepText === undefined ? from : field.max
    }
    for (let at = from; at <= to; at += step) values.add(at)
  }
  return values
}

const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function parseCron(expression: string): Schedule {
  const parts = expression.split(/\s+/)
  if (parts.length !== 5) throw new InvalidScheduleError(`${JSON.stringify(expression)} needs 5 fields: minute hour day-of-month month day-of-week`)
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, fields[index]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (weekdays.delete(7)) weekdays.add(0)
  const anyDay = parts[2] === '*'
  const anyWeekday = parts[4] === '*'
  // Only the day of month restricts the days (cron matches either when both are set): it must fall in one of the months.
  if (!anyDay && anyWeekday && ![...months].some((month) => [...days].some((day) => day <= daysInMonth[month - 1]!))) {
    throw new InvalidScheduleError(`${JSON.stringify(expression)} never fires: none of its months has that day`)
  }
  return { kind: 'cron', minutes, hours, days, months, weekdays, anyDay, anyWeekday }
}

const unitMs: Record<string, number> = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }

/**
 * `text` as a schedule: a 5-field cron expression, an alias (`@hourly`, `@daily`/`@midnight`, `@weekly`, `@monthly`,
 * `@yearly`/`@annually`), `@every <n>m|h|d` (at least 5 minutes), or `at YYYY-MM-DDTHH:MM`; `InvalidScheduleError`
 * otherwise.
 */
export function parseSchedule(text: string): Schedule {
  const trimmed = text.trim()
  if (!trimmed) throw new InvalidScheduleError('The schedule is empty')
  if (trimmed.startsWith('at ')) {
    const local = trimmed.slice(3).trim() as LocalDateTime
    try {
      parseLocalDateTime(local)
    } catch {
      throw new InvalidScheduleError(`${JSON.stringify(local)} isn't a local date and time (at YYYY-MM-DDTHH:MM)`)
    }
    return { kind: 'at', local }
  }
  if (trimmed.startsWith('@every')) {
    const match = /^@every\s+(\d+)([mhd])$/.exec(trimmed)
    if (!match) throw new InvalidScheduleError(`${JSON.stringify(trimmed)} isn't @every <n>m, <n>h or <n>d`)
    const ms = Number(match[1]) * unitMs[match[2]!]!
    if (ms < minEveryMs) throw new InvalidScheduleError('@every must be at least 5 minutes')
    return { kind: 'every', ms }
  }
  if (trimmed.startsWith('@')) {
    const expression = aliases[trimmed.toLowerCase()]
    if (!expression) throw new InvalidScheduleError(`${JSON.stringify(trimmed)} isn't one of ${Object.keys(aliases).join(', ')}, @every`)
    return parseCron(expression)
  }
  return parseCron(trimmed)
}

const dayMs = 24 * 60 * 60 * 1000
const minuteMs = 60 * 1000
/** How far ahead a cron expression is searched: past every leap day. */
const searchDays = 366 * 8

/**
 * The first instant after `after` when `schedule` fires, its local times read in `timeZone`; undefined for a reminder
 * whose time has passed. A local time daylight saving time skips fires past the gap; one it repeats fires the first time.
 */
export function nextOccurrence(schedule: Schedule, after: number, timeZone: string): number | undefined {
  if (schedule.kind === 'every') return after + schedule.ms
  if (schedule.kind === 'at') {
    const at = instantOfWall(parseLocalDateTime(schedule.local), timeZone)
    return at > after ? at : undefined
  }
  const { minutes, hours, days, months, weekdays, anyDay, anyWeekday } = schedule
  const wallAfter = after + offsetAt(after, timeZone)
  const from = wallAfter - (wallAfter % minuteMs)
  const sortedHours = [...hours].sort((a, b) => a - b)
  const sortedMinutes = [...minutes].sort((a, b) => a - b)
  for (let day = Math.floor(from / dayMs) * dayMs, end = day + searchDays * dayMs; day < end; day += dayMs) {
    const date = new Date(day)
    if (!months.has(date.getUTCMonth() + 1)) continue
    const dayMatches = days.has(date.getUTCDate())
    const weekdayMatches = weekdays.has(date.getUTCDay())
    if (!(anyDay || anyWeekday ? dayMatches && weekdayMatches : dayMatches || weekdayMatches)) continue
    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const wall = day + hour * 60 * minuteMs + minute * minuteMs
        if (wall < from) continue
        const instant = instantOfWall(wall, timeZone)
        if (instant > after) return instant
      }
    }
  }
  return undefined
}
