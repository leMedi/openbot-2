import { describe, expect, it } from 'vitest'
import { describeSchedule, type ScheduleForm, scheduleForm, scheduleText, switchKind } from './schedule.ts'

describe('the schedule editor', () => {
  it('reads a daily cron expression as a time every day, and writes it back', () => {
    expect(scheduleForm('30 9 * * *')).toEqual({ kind: 'daily', time: '09:30' })
    expect(scheduleText({ kind: 'daily', time: '09:30' })).toBe('30 9 * * *')
  })
})

describe('every schedule kind', () => {
  const cases: [string, ScheduleForm][] = [
    ['0 8 * * 1-5', { kind: 'weekdays', time: '08:00' }],
    ['45 17 * * 1', { kind: 'weekly', weekday: 1, time: '17:45' }],
    ['0 0 * * 0', { kind: 'weekly', weekday: 0, time: '00:00' }],
    ['15 9 1 * *', { kind: 'monthly', day: 1, time: '09:15' }],
    ['0 9 31 * *', { kind: 'monthly', day: 31, time: '09:00' }],
    ['@hourly', { kind: 'alias', alias: '@hourly' }],
    ['@daily', { kind: 'alias', alias: '@daily' }],
    ['@weekly', { kind: 'alias', alias: '@weekly' }],
    ['@monthly', { kind: 'alias', alias: '@monthly' }],
    ['@yearly', { kind: 'alias', alias: '@yearly' }],
    ['@annually', { kind: 'alias', alias: '@annually' }],
    ['@midnight', { kind: 'alias', alias: '@midnight' }],
    ['@every 15m', { kind: 'every', amount: 15, unit: 'm' }],
    ['@every 2h', { kind: 'every', amount: 2, unit: 'h' }],
    ['@every 1d', { kind: 'every', amount: 1, unit: 'd' }],
    ['at 2026-10-29T09:00', { kind: 'once', at: '2026-10-29T09:00' }],
    ['at 2026-12-31T23:59', { kind: 'once', at: '2026-12-31T23:59' }],
    ['*/5 * * * *', { kind: 'cron', expression: '*/5 * * * *' }],
    ['0 9 * * 6,0', { kind: 'cron', expression: '0 9 * * 6,0' }],
    ['0 9 1 1 *', { kind: 'cron', expression: '0 9 1 1 *' }],
  ]

  it.each(cases)('reads %s and writes it back', (text, form) => {
    expect(scheduleForm(text)).toEqual(form)
    expect(scheduleText(form)).toBe(text)
  })

  it('keeps a time off the quarter hours as custom cron, which the time picker has no room for', () => {
    expect(scheduleForm('7 9 * * *')).toEqual({ kind: 'cron', expression: '7 9 * * *' })
  })

  it('keeps anything it does not understand as custom cron, for the server to judge', () => {
    expect(scheduleForm('@fortnightly')).toEqual({ kind: 'cron', expression: '@fortnightly' })
    expect(scheduleForm('9am please')).toEqual({ kind: 'cron', expression: '9am please' })
  })
})

describe('the schedule in words', () => {
  it.each([
    ['30 9 * * *', 'Every day at 9:30 AM'],
    ['0 8 * * 1-5', 'On weekdays at 8:00 AM'],
    ['45 17 * * 1', 'Every Monday at 5:45 PM'],
    ['0 0 * * 0', 'Every Sunday at 12:00 AM'],
    ['0 12 1 * *', 'Monthly on the 1st at 12:00 PM'],
    ['0 9 2 * *', 'Monthly on the 2nd at 9:00 AM'],
    ['0 9 3 * *', 'Monthly on the 3rd at 9:00 AM'],
    ['0 9 11 * *', 'Monthly on the 11th at 9:00 AM'],
    ['0 9 22 * *', 'Monthly on the 22nd at 9:00 AM'],
    ['@hourly', 'Every hour'],
    ['@midnight', 'At 12:00 AM'],
    ['@annually', 'At 12:00 AM, on day 1 of the month, only in January'],
    ['@every 15m', 'Every 15 minutes'],
    ['@every 1h', 'Every hour'],
    ['@every 2d', 'Every 2 days'],
    ['at 2026-10-29T09:00', 'Once, on Thu, Oct 29, 2026 at 9:00 AM'],
    // Anything else reads as cronstrue says it.
    ['*/5 * * * *', 'Every 5 minutes'],
    ['0 9 * * 1,3', 'At 09:00 AM, only on Monday and Wednesday'],
  ])('%s reads as "%s"', (text, sentence) => {
    expect(describeSchedule(text)).toBe(sentence)
  })

  it('is missing for an expression that is not a schedule', () => {
    expect(describeSchedule('9am please')).toBeUndefined()
    expect(describeSchedule('0 9 * * * *')).toBeUndefined()
    expect(describeSchedule('')).toBeUndefined()
  })
})

describe('switching what kind of schedule it is', () => {
  const tomorrow = '2026-10-29'

  it('keeps the time of day', () => {
    const daily: ScheduleForm = { kind: 'daily', time: '09:30' }
    expect(switchKind(daily, 'weekdays', tomorrow)).toEqual({ kind: 'weekdays', time: '09:30' })
    expect(switchKind(daily, 'weekly', tomorrow)).toEqual({ kind: 'weekly', weekday: 1, time: '09:30' })
    expect(switchKind(daily, 'monthly', tomorrow)).toEqual({ kind: 'monthly', day: 1, time: '09:30' })
    expect(switchKind(daily, 'once', tomorrow)).toEqual({ kind: 'once', at: '2026-10-29T09:30' })
  })

  it('starts from 9:00 AM, every hour or every 30 minutes where there was no time', () => {
    const every: ScheduleForm = { kind: 'every', amount: 15, unit: 'm' }
    expect(switchKind(every, 'daily', tomorrow)).toEqual({ kind: 'daily', time: '09:00' })
    expect(switchKind(every, 'alias', tomorrow)).toEqual({ kind: 'alias', alias: '@hourly' })
    expect(switchKind({ kind: 'daily', time: '09:00' }, 'every', tomorrow)).toEqual({ kind: 'every', amount: 30, unit: 'm' })
  })

  it('to custom cron, starts from the expression it was', () => {
    expect(switchKind({ kind: 'weekdays', time: '08:15' }, 'cron', tomorrow)).toEqual({ kind: 'cron', expression: '15 8 * * 1-5' })
    expect(switchKind({ kind: 'alias', alias: '@daily' }, 'cron', tomorrow)).toEqual({ kind: 'cron', expression: '0 0 * * *' })
    expect(switchKind({ kind: 'every', amount: 15, unit: 'm' }, 'cron', tomorrow)).toEqual({ kind: 'cron', expression: '0 9 * * *' })
  })

  it('to the kind it is, changes nothing', () => {
    const weekly: ScheduleForm = { kind: 'weekly', weekday: 5, time: '18:00' }
    expect(switchKind(weekly, 'weekly', tomorrow)).toBe(weekly)
  })
})
