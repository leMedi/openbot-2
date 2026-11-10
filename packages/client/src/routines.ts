import type { LiveEvent, RoutineInfo, RoutineRunInfo } from '@openbot/api-contract'

/** Routines as the Routines pane lists them: active ones first, each group oldest first. */
export function sortRoutines(routines: readonly RoutineInfo[]): RoutineInfo[] {
  return [...routines].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.createdAt - b.createdAt)
}

/** `bot`'s routines once `event` happened; the same list when it isn't about them, or none while they load. */
export function applyRoutineEvent(routines: RoutineInfo[] | undefined, botId: string, event: LiveEvent): RoutineInfo[] | undefined {
  if (!routines) return routines
  if (event.type === 'routine.updated' && event.routine.botId === botId) {
    const { routine } = event
    return routines.some((entry) => entry.id === routine.id) ? routines.map((entry) => (entry.id === routine.id ? routine : entry)) : [...routines, routine]
  }
  if (event.type === 'routine.deleted' && event.botId === botId) return routines.filter((entry) => entry.id !== event.routineId)
  return routines
}

/** A routine's runs, newest first, once `event` happened; the same list when it isn't about them, or none while they load. */
export function applyRunEvent(runs: RoutineRunInfo[] | undefined, routineId: string, event: LiveEvent): RoutineRunInfo[] | undefined {
  if (!runs || event.type !== 'routineRun.updated' || event.run.routineId !== routineId) return runs
  const { run } = event
  return [run, ...runs.filter((entry) => entry.id !== run.id)].sort((a, b) => b.id - a.id)
}

/** A new routine runs every day at 9:00 AM until the owner picks another schedule. */
export const defaultSchedule = '0 9 * * *'

/** `instant` as a date and time in `timeZone`, e.g. "Thu, Oct 29, 9:00 AM". */
export function formatInstant(instant: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(instant)
}

/** `instant`'s date in `timeZone`, `YYYY-MM-DD`; from its parts, as Hermes (the phone) may not have the en-CA locale. */
export function localDate(instant: number, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(instant)
  const part = (type: string) => parts.find((each) => each.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** How a finished run went, as its run history marks it: a short mark, what it means, and its tone. */
export const runOutcomes: Record<Exclude<RoutineRunInfo['status'], 'running'>, { mark: string; label: string; tone: 'ok' | 'error' | 'muted' }> = {
  ran: { mark: '✓', label: 'Ran', tone: 'ok' },
  failed: { mark: '✗', label: 'Failed', tone: 'error' },
  skipped_overlap: { mark: 'Skipped', label: 'Skipped: the previous run was still going', tone: 'muted' },
  missed: { mark: 'Missed', label: 'Missed while the server was down', tone: 'muted' },
}
