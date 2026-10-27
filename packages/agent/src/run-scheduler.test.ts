import type { BotInput } from '@openbot/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type BotHistories, type QueuedInput, RunScheduler } from './run-scheduler.ts'

/**
 * A bot's history as the scheduler sees it: each submission starts a run that ends when the test finishes it, or when
 * it is aborted, unless the run ignores aborts. `log` records what reached the history, in order.
 */
function fakeRuns() {
  const log: string[] = []
  let current: { end: () => void; ended: Promise<void>; done: boolean; answered: boolean } | undefined
  let stubborn = false
  let answersFirst = false
  let submitting: Promise<void> | undefined
  const histories: BotHistories = {
    async submit(_botId, inputs) {
      await submitting
      log.push(`run ${inputs.map(label).join(' + ')}`)
      let end!: () => void
      const run = { end: () => end(), ended: new Promise<void>((resolve) => (end = resolve)), done: false, answered: false }
      void run.ended.then(() => (run.done = true))
      current = run
      return { ended: async () => run.done, answered: async () => run.answered }
    },
    idle: async () => current?.ended,
    async abort() {
      log.push('abort')
      if (current && answersFirst && !current.done) current.answered = true
      if (!stubborn) current?.end()
      await current?.ended
    },
  }
  return {
    histories,
    log,
    /** Ends the current run as if it answered. */
    finish() {
      if (current && !current.done) current.answered = true
      current?.end()
    },
    /** Runs from now on answer just before an abort reaches them. */
    answerBeforeAborts: () => (answersFirst = true),
    /** Runs from now on ignore aborts, as a wedged tool would. */
    ignoreAborts: () => (stubborn = true),
    /** Holds every submission until the returned function is called. */
    holdSubmissions() {
      let release!: () => void
      submitting = new Promise((resolve) => (release = resolve))
      return release
    },
  }
}

const label = (input: QueuedInput) =>
  `${input.text}${input.attempt ? ` (attempt ${input.attempt + 1})` : ''}${input.supersedes ? ' (supersedes)' : ''}`

const owner = (text: string): BotInput => ({ lane: 'owner', text, id: text })
const bot = (text: string, priority = false): BotInput => ({ lane: 'bot', text, id: text, priority })
const groupTurn = (text: string): BotInput => ({ lane: 'owner', text, id: text, groupChatId: 'group-1' })

/** Lets the scheduler's promise chains settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

let schedulers: RunScheduler[] = []
afterEach(() => {
  for (const scheduler of schedulers) scheduler.close()
  schedulers = []
  vi.useRealTimers()
})

function start(watchdog?: { interruptAfterMs: number; detachAfterMs: number }) {
  const fake = fakeRuns()
  const working: boolean[] = []
  const scheduler = new RunScheduler({
    histories: fake.histories,
    onWorking: (_botId, value) => working.push(value),
    onError: (_botId, error) => fake.log.push(`error ${error.message}`),
    watchdog,
  })
  schedulers.push(scheduler)
  return { ...fake, scheduler, working }
}

describe('an owner message', () => {
  it('interrupts a bot-lane run, which is redelivered after it', async () => {
    const { scheduler, log, finish } = start()
    scheduler.wake('rex', bot('Review my PR'))
    await settled()

    scheduler.wake('rex', owner('Fix the build'))
    await settled()
    finish()
    await settled()
    finish()
    await settled()

    expect(log).toEqual(['run Review my PR', 'abort', 'run Fix the build', 'run Review my PR (attempt 2)'])
  })

  it('supersedes a run answering the owner, and the messages waiting run together', async () => {
    const { scheduler, log, finish } = start()
    scheduler.wake('rex', owner('Fix the build'))
    await settled()
    expect(scheduler.superseded('rex')).toBe(false)

    scheduler.wake('rex', owner('Use pnpm'))
    scheduler.wake('rex', owner('And run the tests'))
    expect(scheduler.superseded('rex')).toBe(true)
    await settled()
    finish()
    await settled()

    expect(log).toEqual(['run Fix the build', 'abort', 'run Use pnpm (supersedes) + And run the tests (supersedes)'])
    expect(scheduler.superseded('rex')).toBe(false)
  })
})

describe('races', () => {
  it('a priority message and then an owner message interrupt a bot-lane run once, and run in lane order', async () => {
    const { scheduler, log, finish } = start()
    scheduler.wake('rex', bot('Review my PR'))
    await settled()

    scheduler.wake('rex', bot('The build is down!', true))
    scheduler.wake('rex', owner('Fix the build'))
    await settled()
    for (let i = 0; i < 3; i++) {
      finish()
      await settled()
    }

    expect(log).toEqual([
      'run Review my PR',
      'abort',
      'run Fix the build',
      'run The build is down!',
      'run Review my PR (attempt 2)',
    ])
  })

  it('a priority message never interrupts a run for the owner', async () => {
    const { scheduler, log, finish } = start()
    scheduler.wake('rex', owner('Fix the build'))
    await settled()

    scheduler.wake('rex', bot('The build is down!', true))
    await settled()
    finish()
    await settled()
    finish()
    await settled()

    expect(log).toEqual(['run Fix the build', 'run The build is down!'])
  })

  it('an owner message during the submission of a run interrupts it once submitted', async () => {
    const { scheduler, log, finish, holdSubmissions } = start()
    const release = holdSubmissions()
    scheduler.wake('rex', bot('Review my PR'))
    await settled()

    scheduler.wake('rex', owner('Fix the build'))
    release()
    await settled()
    finish()
    await settled()
    finish()
    await settled()

    expect(log).toEqual(['run Review my PR', 'abort', 'run Fix the build', 'run Review my PR (attempt 2)'])
  })

  it('a run that answers just before its abort lands is not run again', async () => {
    const { scheduler, log, finish, answerBeforeAborts } = start()
    scheduler.wake('rex', bot('Review my PR'))
    await settled()
    answerBeforeAborts()

    scheduler.wake('rex', owner('Fix the build'))
    await settled()
    finish()
    await settled()

    expect(log).toEqual(['run Review my PR', 'abort', 'run Fix the build'])
    expect(scheduler.working('rex')).toBe(false)
  })

  it('an interrupt asked after the run ended does nothing', async () => {
    const { scheduler, log, finish } = start()
    scheduler.wake('rex', bot('Review my PR'))
    await settled()
    finish()

    scheduler.wake('rex', owner('Fix the build'))
    await settled()
    finish()
    await settled()

    expect(log).toEqual(['run Review my PR', 'run Fix the build'])
  })
})

describe('queued work', () => {
  it('is never dropped, however often it is interrupted', async () => {
    const { scheduler, log, finish } = start()
    scheduler.wake('rex', bot('Review my PR'))
    await settled()
    scheduler.wake('rex', bot('The build is down!', true))
    await settled()
    finish()
    await settled()
    scheduler.wake('rex', owner('Fix the build'))
    await settled()
    for (let i = 0; i < 2; i++) {
      finish()
      await settled()
    }

    expect(log).toEqual([
      'run Review my PR',
      'abort',
      'run The build is down!',
      'run Review my PR (attempt 2)',
      'abort',
      'run Fix the build',
      'run Review my PR (attempt 3)',
    ])
    expect(scheduler.working('rex')).toBe(false)
  })

  it('settles a group turn only once its retried run has ended, giving up after three runs', async () => {
    const { scheduler, log, finish } = start()
    let ended = false
    scheduler.wake('rex', { ...groupTurn('Your turn in Launch'), settle: () => (ended = true) })
    for (const message of ['Quick question', 'Another one', 'And a third']) {
      await settled()
      scheduler.wake('rex', owner(message))
      await settled()
      finish()
      await settled()
    }
    expect(ended).toBe(true)

    expect(log).toEqual([
      'run Your turn in Launch',
      'abort',
      'run Quick question',
      'run Your turn in Launch (attempt 2)',
      'abort',
      'run Another one',
      'run Your turn in Launch (attempt 3)',
      'abort',
      'run And a third',
    ])
  })
})

describe('the watchdog', () => {
  it("interrupts a run the owner's message waits for again after 120 s, then detaches it 30 s later", async () => {
    vi.useFakeTimers()
    const { scheduler, log, ignoreAborts, finish } = start()
    scheduler.wake('rex', bot('Review my PR'))
    await vi.advanceTimersByTimeAsync(0)
    ignoreAborts()

    scheduler.wake('rex', owner('Fix the build'))
    // The run's work gives up once detached, as the runtime's tools do.
    void scheduler.detached('rex').then(() => {
      log.push('detach')
      finish()
    })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(log).toEqual(['run Review my PR', 'abort'])
    await vi.advanceTimersByTimeAsync(1)
    expect(log).toEqual(['run Review my PR', 'abort', 'abort'])
    await vi.advanceTimersByTimeAsync(29_999)
    expect(log).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)

    expect(log).toEqual(['run Review my PR', 'abort', 'abort', 'detach', 'run Fix the build'])
  })

  it('stays quiet when the run ends in time', async () => {
    vi.useFakeTimers()
    const { scheduler, log, finish } = start()
    scheduler.wake('rex', bot('Review my PR'))
    await vi.advanceTimersByTimeAsync(0)
    scheduler.wake('rex', owner('Fix the build'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(200_000)
    finish()
    await vi.advanceTimersByTimeAsync(200_000)

    expect(log).toEqual(['run Review my PR', 'abort', 'run Fix the build', 'run Review my PR (attempt 2)'])
  })
})
