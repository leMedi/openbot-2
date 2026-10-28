import { describe, expect, it } from 'vitest'
import { describeSchedule, InvalidScheduleError, nextOccurrence, parseSchedule } from './schedules.ts'

/** The next time `schedule` fires after `after` (an ISO instant) in `timeZone`, as an ISO instant. */
function next(schedule: string, after: string, timeZone = 'UTC') {
  const at = nextOccurrence(parseSchedule(schedule), Date.parse(after), timeZone)
  return at === undefined ? undefined : new Date(at).toISOString()
}

describe('a schedule', () => {
  it.each([
    ['0 8 * * 1-5', '2026-10-30T08:00:00Z', '2026-11-02T08:00:00.000Z'],
    ['0 8 * * 1-5', '2026-10-30T07:59:00Z', '2026-10-30T08:00:00.000Z'],
    ['*/15 * * * *', '2026-10-28T12:07:00Z', '2026-10-28T12:15:00.000Z'],
    ['30 9 1,15 * *', '2026-10-15T09:30:00Z', '2026-11-01T09:30:00.000Z'],
    ['0 0 29 2 *', '2026-03-01T00:00:00Z', '2028-02-29T00:00:00.000Z'],
    ['0 12 * JAN-MAR MON', '2026-10-28T00:00:00Z', '2027-01-04T12:00:00.000Z'],
    ['0 12 * * 7', '2026-10-28T00:00:00Z', '2026-11-01T12:00:00.000Z'],
    // Day of month and day of week both set: either matches, as in cron.
    ['0 6 13 * 5', '2026-10-28T00:00:00Z', '2026-10-30T06:00:00.000Z'],
  ])('%s fires after %s at %s', (schedule, after, expected) => {
    expect(next(schedule, after)).toBe(expected)
  })

  it.each([
    ['@hourly', '2026-10-28T12:07:00Z', '2026-10-28T13:00:00.000Z'],
    ['@daily', '2026-10-28T12:07:00Z', '2026-10-29T00:00:00.000Z'],
    ['@midnight', '2026-10-28T12:07:00Z', '2026-10-29T00:00:00.000Z'],
    ['@weekly', '2026-10-28T12:07:00Z', '2026-11-01T00:00:00.000Z'],
    ['@monthly', '2026-10-28T12:07:00Z', '2026-11-01T00:00:00.000Z'],
    ['@yearly', '2026-10-28T12:07:00Z', '2027-01-01T00:00:00.000Z'],
    ['@annually', '2026-10-28T12:07:00Z', '2027-01-01T00:00:00.000Z'],
  ])('%s fires after %s at %s', (schedule, after, expected) => {
    expect(next(schedule, after)).toBe(expected)
  })

  it('fires at local times in the time zone it is given', () => {
    expect(next('0 8 * * *', '2026-10-28T12:00:00Z', 'Europe/Paris')).toBe('2026-10-29T07:00:00.000Z')
    // Paris leaves daylight saving time on October 25th, 2026.
    expect(next('0 8 * * *', '2026-10-24T12:00:00Z', 'Europe/Paris')).toBe('2026-10-25T07:00:00.000Z')
    expect(next('0 8 * * *', '2026-10-23T12:00:00Z', 'Europe/Paris')).toBe('2026-10-24T06:00:00.000Z')
  })

  it('fires past the gap at a time daylight saving time skips, and once at a time it repeats', () => {
    // Paris skips 02:00–03:00 on March 29th, 2026, and repeats 02:00–03:00 on October 25th.
    expect(next('30 2 * * *', '2026-03-28T12:00:00Z', 'Europe/Paris')).toBe('2026-03-29T01:30:00.000Z')
    expect(next('30 2 * * *', '2026-10-24T12:00:00Z', 'Europe/Paris')).toBe('2026-10-25T00:30:00.000Z')
    expect(next('30 2 * * *', '2026-10-25T00:30:00Z', 'Europe/Paris')).toBe('2026-10-26T01:30:00.000Z')
  })

  it('every n minutes, hours or days fires that long after, whatever the time zone', () => {
    expect(next('@every 15m', '2026-10-28T12:07:00Z', 'Asia/Tokyo')).toBe('2026-10-28T12:22:00.000Z')
    expect(next('@every 2h', '2026-10-28T12:07:00Z')).toBe('2026-10-28T14:07:00.000Z')
    expect(next('@every 1d', '2026-10-28T12:07:00Z')).toBe('2026-10-29T12:07:00.000Z')
  })

  it('at a local date and time fires once, then never', () => {
    expect(next('at 2026-10-29T09:00', '2026-10-28T12:00:00Z', 'Europe/Paris')).toBe('2026-10-29T08:00:00.000Z')
    expect(next('at 2026-10-29T09:00', '2026-10-29T08:00:00Z', 'Europe/Paris')).toBeUndefined()
  })

  it.each([
    ['', /empty/],
    ['0 8 * *', /5 fields/],
    ['60 8 * * *', /minute/],
    ['0 24 * * *', /hour/],
    ['0 8 0 * *', /day of month/],
    ['0 8 * 13 *', /month/],
    ['0 8 * * 8', /day of week/],
    ['*/0 * * * *', /step/],
    ['0 8 * * FUN', /day of week/],
    ['0 0 31 2 *', /never/],
    ['@fortnightly', /@hourly/],
    ['@every 4m', /at least 5 minutes/],
    ['@every 299s', /@every/],
    ['@every soon', /@every/],
    ['at tomorrow', /YYYY-MM-DDTHH:MM/],
    ['at 2026-02-30T09:00', /YYYY-MM-DDTHH:MM/],
  ])('%j is refused', (schedule, message) => {
    expect(() => parseSchedule(schedule)).toThrow(InvalidScheduleError)
    expect(() => parseSchedule(schedule)).toThrow(message)
  })
})

describe('a schedule in words', () => {
  it.each([
    ['0 8 * * 1-5', 'every weekday at 08:00'],
    ['30 9 * * *', 'every day at 09:30'],
    ['0 8,17 * * *', 'every day at 08:00 and 17:00'],
    ['0 18 * * 0,6', 'every weekend day at 18:00'],
    ['0 12 * JAN-MAR MON', 'every Monday at 12:00, in January, February and March'],
    ['30 9 1,15 * *', 'on day 1 and 15 of the month at 09:30'],
    ['15 * * * *', 'every hour at :15'],
    ['@daily', 'every day at 00:00'],
    ['@hourly', 'every hour at :00'],
    ['@weekly', 'every Sunday at 00:00'],
    ['@every 15m', 'every 15 minutes'],
    ['@every 1h', 'every hour'],
    ['@every 2d', 'every 2 days'],
    ['at 2026-10-29T09:00', 'once, on 2026-10-29 at 09:00'],
    ['*/15 * * * *', 'on cron schedule "*/15 * * * *"'],
  ])('reads %s as %j', (schedule, words) => {
    expect(describeSchedule(schedule)).toBe(words)
  })
})
