import type { RoutineInfo, RoutineRunInfo } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { applyRoutineEvent, applyRunEvent, sortRoutines } from './routines.ts'

const routine = (id: string, changes: Partial<RoutineInfo> = {}): RoutineInfo => ({
  id,
  botId: 'bot-1',
  name: `Routine ${id}`,
  prompt: 'Do it',
  schedule: '0 9 * * *',
  enabled: true,
  nextRunAt: null,
  createdBy: 'owner',
  running: false,
  createdAt: 0,
  updatedAt: 0,
  ...changes,
})

const run = (id: number, changes: Partial<RoutineRunInfo> = {}): RoutineRunInfo => ({
  id,
  routineId: 'r1',
  scheduledFor: id * 1000,
  firedAt: id * 1000,
  status: 'ran',
  finishedAt: id * 1000 + 1,
  message: null,
  test: false,
  ...changes,
})

describe('the routines list', () => {
  it('shows active routines first, each group oldest first', () => {
    const list = [
      routine('a', { enabled: false, createdAt: 1 }),
      routine('b', { createdAt: 2 }),
      routine('c', { enabled: false, createdAt: 3 }),
      routine('d', { createdAt: 4 }),
    ]
    expect(sortRoutines(list).map((entry) => entry.id)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('adds a routine created live, and shows a changed one as it is now', () => {
    const list = [routine('a')]
    const added = applyRoutineEvent(list, 'bot-1', { type: 'routine.updated', routine: routine('b') })
    expect(added?.map((entry) => entry.id)).toEqual(['a', 'b'])

    const changed = applyRoutineEvent(added, 'bot-1', { type: 'routine.updated', routine: routine('a', { running: true }) })
    expect(changed?.find((entry) => entry.id === 'a')?.running).toBe(true)
  })

  it('drops a deleted routine', () => {
    const list = [routine('a'), routine('b')]
    expect(applyRoutineEvent(list, 'bot-1', { type: 'routine.deleted', botId: 'bot-1', routineId: 'a' })?.map((entry) => entry.id)).toEqual(['b'])
  })

  it("ignores another bot's routines, other events, and a list not loaded yet", () => {
    const list = [routine('a')]
    expect(applyRoutineEvent(list, 'bot-1', { type: 'routine.updated', routine: routine('x', { botId: 'bot-2' }) })).toBe(list)
    expect(applyRoutineEvent(list, 'bot-1', { type: 'routine.deleted', botId: 'bot-2', routineId: 'a' })).toBe(list)
    expect(applyRoutineEvent(list, 'bot-1', { type: 'timeZone.updated', timeZone: 'Europe/Paris' })).toBe(list)
    expect(applyRoutineEvent(undefined, 'bot-1', { type: 'routine.updated', routine: routine('a') })).toBeUndefined()
  })
})

describe('the run history', () => {
  it('shows a new run on top, and a finished run as it ended', () => {
    const runs = [run(2), run(1)]
    const started = applyRunEvent(runs, 'r1', { type: 'routineRun.updated', botId: 'bot-1', run: run(3, { status: 'running', finishedAt: null }) })
    expect(started?.map((entry) => [entry.id, entry.status])).toEqual([
      [3, 'running'],
      [2, 'ran'],
      [1, 'ran'],
    ])

    const failed = applyRunEvent(started, 'r1', { type: 'routineRun.updated', botId: 'bot-1', run: run(3, { status: 'failed' }) })
    expect(failed?.map((entry) => [entry.id, entry.status])).toEqual([
      [3, 'failed'],
      [2, 'ran'],
      [1, 'ran'],
    ])
  })

  it("ignores another routine's runs and a history not loaded yet", () => {
    const runs = [run(1)]
    expect(applyRunEvent(runs, 'r1', { type: 'routineRun.updated', botId: 'bot-1', run: run(5, { routineId: 'r2' }) })).toBe(runs)
    expect(applyRunEvent(undefined, 'r1', { type: 'routineRun.updated', botId: 'bot-1', run: run(5) })).toBeUndefined()
  })
})
