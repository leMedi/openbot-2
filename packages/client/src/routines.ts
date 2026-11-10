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
