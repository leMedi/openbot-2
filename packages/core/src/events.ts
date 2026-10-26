/** Each server start gets a new epoch; `seq` counts events within it. Clients reconcile by `seq` and refetch on a new epoch. */
export type Stamp = { epoch: string; seq: number }

export type Stamped<E> = Stamp & { event: E }

/** The live event stream every client subscribes to. Events are not persisted; a reconnecting client refetches. */
export class EventBus<E> {
  readonly epoch: string
  #seq = 0
  #subscribers = new Set<(event: Stamped<E>) => void>()

  constructor(epoch: string = crypto.randomUUID()) {
    this.epoch = epoch
  }

  get seq() {
    return this.#seq
  }

  publish(event: E): Stamped<E> {
    const stamped = { epoch: this.epoch, seq: ++this.#seq, event }
    for (const notify of this.#subscribers) notify(stamped)
    return stamped
  }

  /** Events published after this call (not after the first `next()`), until `signal` aborts. */
  subscribe(signal?: AbortSignal): AsyncGenerator<Stamped<E>> {
    const queue: Stamped<E>[] = []
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
