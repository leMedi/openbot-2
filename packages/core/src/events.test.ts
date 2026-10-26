import { describe, expect, it } from 'vitest'
import { EventBus } from './events.ts'

describe('event bus', () => {
  it('delivers events published after subscribing, stamped in order', async () => {
    const bus = new EventBus<{ type: string }>('epoch-1')
    bus.publish({ type: 'before' })
    const controller = new AbortController()
    const events = bus.subscribe(controller.signal)

    bus.publish({ type: 'first' })
    bus.publish({ type: 'second' })

    expect((await events.next()).value).toEqual({ epoch: 'epoch-1', seq: 2, event: { type: 'first' } })
    expect((await events.next()).value).toEqual({ epoch: 'epoch-1', seq: 3, event: { type: 'second' } })
    controller.abort()
    expect((await events.next()).done).toBe(true)
  })
})
