/** Each server start gets a new epoch; `seq` counts events within it. Clients reconcile by `seq` and refetch on a new epoch. */
export type Stamp = { epoch: string; seq: number }

export type Stamped<E> = Stamp & { event: E }

/**
 * The live event stream every client subscribes to. Events are not persisted, but the latest few are kept in memory so
 * a client that reconnects within the same epoch can catch up; otherwise it refetches.
 */
export class EventBus<E> {
  readonly epoch: string
  #seq = 0
  #subscribers = new Set<(event: Stamped<E>) => void>()
  /** The latest events, oldest first. */
  #kept: Stamped<E>[] = []
  readonly #keep: number

  constructor(epoch: string = crypto.randomUUID(), { keep = 1000 }: { keep?: number } = {}) {
    this.epoch = epoch
    this.#keep = keep
  }

  get seq() {
    return this.#seq
  }

  publish(event: E): Stamped<E> {
    const stamped = { epoch: this.epoch, seq: ++this.#seq, event }
    this.#kept.push(stamped)
    if (this.#kept.length > this.#keep) this.#kept.shift()
    for (const notify of this.#subscribers) notify(stamped)
    return stamped
  }

  /** Whether every event of this epoch published after `seq` is still kept, so a subscriber can resume from it. */
  canResume(seq: number): boolean {
    return seq <= this.#seq && seq >= this.#seq - this.#kept.length
  }

  /**
   * Events published after this call (not after the first `next()`), until `signal` aborts. With `after`, which must
   * pass `canResume`, the kept events after that sequence come first.
   */
  subscribe(signal?: AbortSignal, { after }: { after?: number } = {}): AsyncGenerator<Stamped<E>> {
    const queue: Stamped<E>[] = after === undefined ? [] : this.#kept.filter((event) => event.seq > after)
    let wakeUp: (() => void) | undefined
    const notify = (event: Stamped<E>) => {
      queue.push(event)
      wakeUp?.()
    }
    const subscribers = this.#subscribers
    // Also unsubscribes a stream that was never iterated, whose `finally` never runs.
    const onAbort = () => {
      subscribers.delete(notify)
      wakeUp?.()
    }
    subscribers.add(notify)
    signal?.addEventListener('abort', onAbort)

    return (async function* () {
      try {
        while (!signal?.aborted) {
          const next = queue.shift()
          if (next) {
            yield next
            continue
          }
          await new Promise<void>((resolve) => (wakeUp = resolve))
          wakeUp = undefined
        }
      } finally {
        subscribers.delete(notify)
        signal?.removeEventListener('abort', onAbort)
      }
    })()
  }
}
