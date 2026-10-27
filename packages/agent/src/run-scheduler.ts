import type { BotInput } from '@openbot/core'

/** An input in a bot's queue. */
export type QueuedInput = BotInput & {
  /** How many of its runs were interrupted; it then runs again (see `RunScheduler`). */
  attempt?: number
  /** It interrupted a run answering the owner's earlier messages, which the bot may not have answered yet. */
  supersedes?: boolean
  /** Called once its run has ended for good, or it was dropped (the bot deleted, the scheduler closed). */
  settle?: () => void
}

/** A run of a bot's history that the scheduler started. */
export type Run = {
  /** Whether it has already ended. */
  ended(): Promise<boolean>
  /** Whether it ended with an answer: an interrupt came too late to stop it. */
  answered(): Promise<boolean>
}

/** Each bot's history, as the scheduler drives it. */
export type BotHistories = {
  /** Starts a run of the bot's history for `inputs`, its idle history's next input; resolves once submitted. */
  submit(botId: string, inputs: QueuedInput[]): Promise<Run>
  /** Resolves once the bot's history is idle. */
  idle(botId: string): Promise<void>
  /** Aborts the bot's run, its running tool included; resolves once its history is idle. */
  abort(botId: string): Promise<void>
}

/** Grok's watchdog: how long the owner's message waits behind a run before it is interrupted again, then detached. */
export type Watchdog = { interruptAfterMs: number; detachAfterMs: number }

export const defaultWatchdog: Watchdog = { interruptAfterMs: 120_000, detachAfterMs: 30_000 }

/** A group turn runs at most this many times when the owner's DM messages interrupt it. */
export const maxGroupTurnAttempts = 3

export type RunSchedulerOptions = {
  histories: BotHistories
  /** The bot started working, or has nothing left to do. */
  onWorking(botId: string, working: boolean): void
  /** A run couldn't start. */
  onError(botId: string, error: Error): void
  /** An interrupt queued `input` to run again, with its new attempt; the next run waits for it to resolve. */
  onRequeue(botId: string, input: QueuedInput): Promise<void>
  watchdog?: Watchdog
}

/** A message the owner sent the bot in its DM: it supersedes whatever the bot is doing. */
const isOwnerMessage = (input: BotInput) => input.lane === 'owner' && !input.groupChatId

/**
 * Where an input goes in a queue: the owner's messages first, then group turns, priority bot messages, interrupted work,
 * the bot lane, the background lane.
 */
function rank(input: QueuedInput): number {
  if (isOwnerMessage(input)) return 0
  if (input.groupChatId) return 1
  if (input.priority) return 2
  if (input.attempt) return 3
  return input.lane === 'bot' ? 4 : 5
}

const couldntInterrupt = (botId: string, error: unknown) => console.error(`[agent] Couldn't interrupt bot ${botId}:`, error)

/** Queues `input` after everything of its rank or higher. */
function enqueue(queue: QueuedInput[], input: QueuedInput) {
  const at = queue.findIndex((queued) => rank(queued) > rank(input))
  if (at === -1) queue.push(input)
  else queue.splice(at, 0, input)
}

/** The run a bot's driver started, for `inputs`. */
type ActiveRun = {
  inputs: QueuedInput[]
  /** A newer input asked to interrupt it; asking again does nothing. */
  interrupted: boolean
  /** The owner's message waits for it, so what it would send the owner answers an outdated request. */
  superseded: boolean
  /** Its run, once submitted. */
  run?: Run
  /** Resolves once the watchdog gives up on the run. */
  detached: Promise<void>
  detach(): void
  /** The watchdog's timers. */
  timers: ReturnType<typeof setTimeout>[]
}

type BotState = {
  queue: QueuedInput[]
  active?: ActiveRun
  driving: boolean
  working: boolean
  /** A run the watchdog detached is still ending, and the next waits to be submitted after it. */
  detachedEnding: boolean
  /** Submissions and aborts, in order, so an abort reaches the run it was meant for. */
  chain: Promise<unknown>
}

/**
 * Each bot's queue and the one run at a time it drives (Grok's `run-scheduler.ts`). The driver submits the next
 * input once the bot's history is idle and waits for its run to end.
 *
 * - **The owner's message supersedes** the run going on, whatever it is: the run is aborted, its running tool
 *   included, and the owner's messages waiting run next, together. A bot- or background-lane input interrupted this way
 *   runs again after them; a group turn is retried, up to `maxGroupTurnAttempts` runs; the owner's own earlier messages
 *   are already in the history, and the new run answers them too.
 * - **A priority input** interrupts a bot- or background-lane run the same way, never a run for the owner.
 * - **Queued work is never dropped**, only when the bot is deleted or the scheduler closes; a group turn interrupted on
 *   its last attempt ends there, and its rounds go on.
 * - **Watchdog:** when the owner's message has waited `interruptAfterMs` behind a run, the run is aborted again; if it
 *   still hasn't ended `detachAfterMs` later, it is detached and the queue moves on.
 *
 * Interrupts are decided after the run's submission, in order with it: a run that already ended has nothing to interrupt.
 */
export class RunScheduler {
  readonly #options: RunSchedulerOptions
  readonly #watchdog: Watchdog
  readonly #bots = new Map<string, BotState>()
  #closed = false

  constructor(options: RunSchedulerOptions) {
    this.#options = options
    this.#watchdog = options.watchdog ?? defaultWatchdog
  }

  /** Queues `input`, interrupting the bot's run when it should; false when the input is there already. */
  wake(botId: string, input: QueuedInput): boolean {
    const bot = this.#bot(botId)
    const { active, queue } = bot
    if (input.id && [...(active?.inputs ?? []), ...queue].some((queued) => queued.id === input.id)) return false
    this.#setWorking(botId, bot, true)
    const queued = { ...input }
    enqueue(queue, queued)
    if (active && isOwnerMessage(queued)) {
      if (active.inputs.some(isOwnerMessage)) queued.supersedes = true
      active.superseded = true
      this.#interrupt(botId, bot, active)
      this.#watch(botId, active)
    } else if (active && queued.priority && !active.inputs.some((running) => running.lane === 'owner')) {
      this.#interrupt(botId, bot, active)
    }
    this.#drive(botId, bot)
    return true
  }

  /**
   * Whether what the bot's run sends the owner now is outdated: their newer message waits for the run, or the run is a
   * detached one still ending while the next waits to be submitted.
   */
  superseded(botId: string): boolean {
    const bot = this.#bots.get(botId)
    const active = bot?.active
    return !!active && (active.superseded || (bot.detachedEnding && !active.run))
  }

  /**
   * Resolves once the watchdog gives up on the bot's current run; never when it has none. The run's work should then
   * give up too, so its history can go on.
   */
  detached(botId: string): Promise<void> {
    return this.#bots.get(botId)?.active?.detached ?? new Promise(() => {})
  }

  working(botId: string): boolean {
    return this.#bots.get(botId)?.working ?? false
  }

  /**
   * Ends every bot's turns in a deleted group chat: those queued are dropped, their waiters told they ended, and a
   * turn's run going on is aborted, after its submission, not to run again.
   */
  async endGroup(groupChatId: string): Promise<void> {
    const inGroup = (input: QueuedInput) => input.groupChatId === groupChatId
    await Promise.all(
      [...this.#bots].map(([botId, bot]) => {
        for (const input of bot.queue.filter(inGroup)) input.settle?.()
        bot.queue = bot.queue.filter((input) => !inGroup(input))
        const { active } = bot
        if (!active?.inputs.some(inGroup)) return
        // Interrupted for good: no later interrupt queues it again.
        active.interrupted = true
        return this.#serially(bot, async () => {
          if (bot.active !== active || !active.run || (await active.run.ended())) return
          await Promise.race([this.#options.histories.abort(botId), active.detached])
        }).catch((error) => couldntInterrupt(botId, error))
      }),
    )
  }

  /** Drops everything queued for the bot; those waiting on it are told it ended. Its run is the caller's to abort. */
  forget(botId: string) {
    const bot = this.#bots.get(botId)
    if (!bot) return
    for (const input of bot.queue.splice(0)) input.settle?.()
  }

  close() {
    this.#closed = true
    for (const botId of this.#bots.keys()) this.forget(botId)
  }

  #bot(botId: string): BotState {
    let bot = this.#bots.get(botId)
    if (!bot) {
      bot = { queue: [], driving: false, working: false, detachedEnding: false, chain: Promise.resolve() }
      this.#bots.set(botId, bot)
    }
    return bot
  }

  /** Runs `work` after the bot's earlier submissions and aborts. */
  #serially<T>(bot: BotState, work: () => Promise<T>): Promise<T> {
    const done = bot.chain.then(work, work)
    bot.chain = done.catch(() => {})
    return done
  }

  /** The inputs of the next run: the next input, or every owner's message waiting, which run together. */
  #next(bot: BotState): QueuedInput[] {
    const first = bot.queue.shift()
    if (!first || !isOwnerMessage(first)) return first ? [first] : []
    const rest = bot.queue.filter(isOwnerMessage)
    bot.queue = bot.queue.filter((input) => !isOwnerMessage(input))
    return [first, ...rest]
  }

  /** Runs the bot's queue until it is empty, unless a driver already is. */
  #drive(botId: string, bot: BotState) {
    if (bot.driving) return
    bot.driving = true
    void (async () => {
      for (let inputs; !this.#closed && (inputs = this.#next(bot)).length; ) {
        let detach!: () => void
        const detached = new Promise<void>(
          (resolve) =>
            (detach = () => {
              bot.detachedEnding = true
              resolve()
            }),
        )
        const active: ActiveRun = { inputs, interrupted: false, superseded: false, detached, detach, timers: [] }
        bot.active = active
        try {
          // Chained at once, so an interrupt asked from now on comes after it.
          await this.#serially(bot, async () => {
            try {
              active.run = await this.#options.histories.submit(botId, inputs)
            } finally {
              // Submitting waited for the history to be idle: a detached run has ended.
              bot.detachedEnding = false
            }
          })
          await Promise.race([this.#options.histories.idle(botId), detached])
          // Any interrupt of this run, asked while it went on.
          await Promise.race([bot.chain, detached])
        } catch (error) {
          if (this.#closed) break
          this.#options.onError(botId, error as Error)
        } finally {
          for (const timer of active.timers) clearTimeout(timer)
          bot.active = undefined
          for (const input of inputs) input.settle?.()
        }
      }
      bot.driving = false
      this.#setWorking(botId, bot, false)
    })()
  }

  /**
   * Aborts `active`'s run, once, queueing its inputs to run again (see `#requeue`) unless it answered before the abort
   * reached it.
   */
  #interrupt(botId: string, bot: BotState, active: ActiveRun) {
    if (active.interrupted) return
    active.interrupted = true
    void this.#serially(bot, async () => {
      const { run } = active
      if (bot.active !== active || !run || (await run.ended())) return
      await Promise.race([this.#options.histories.abort(botId), active.detached])
      if (!(await run.answered())) for (const input of active.inputs) await this.#requeue(botId, bot, input)
    }).catch((error) => couldntInterrupt(botId, error))
  }

  /**
   * Queues an interrupted run's input to run again, moving its waiter there. The owner's messages don't: they are in
   * the history, and the run superseding them answers them. A group turn gives up after `maxGroupTurnAttempts` runs.
   */
  async #requeue(botId: string, bot: BotState, input: QueuedInput) {
    if (isOwnerMessage(input)) return
    const attempt = (input.attempt ?? 0) + 1
    if (input.groupChatId && attempt >= maxGroupTurnAttempts) return
    const requeued = { ...input, attempt }
    enqueue(bot.queue, requeued)
    input.settle = undefined
    await this.#options.onRequeue(botId, requeued)
  }

  /** Starts the watchdog on `active`, which the owner's message now waits for. */
  #watch(botId: string, active: ActiveRun) {
    if (active.timers.length) return
    const { interruptAfterMs, detachAfterMs } = this.#watchdog
    active.timers.push(
      setTimeout(() => {
        console.warn(`[agent] Bot ${botId}'s run hasn't ended ${interruptAfterMs / 1000} s after the owner's message; interrupting it again`)
        void this.#options.histories.abort(botId).catch((error) => couldntInterrupt(botId, error))
        active.timers.push(
          setTimeout(() => {
            console.warn(`[agent] Bot ${botId}'s run ignored its interrupt; detaching it`)
            active.detach()
          }, detachAfterMs),
        )
      }, interruptAfterMs),
    )
  }

  #setWorking(botId: string, bot: BotState, working: boolean) {
    if (bot.working === working) return
    bot.working = working
    this.#options.onWorking(botId, working)
  }
}
