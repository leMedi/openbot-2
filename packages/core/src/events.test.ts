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

  it('replays the events after a sequence it still keeps, then continues live', async () => {
    const bus = new EventBus<{ type: string }>('epoch-1', { keep: 3 })
    for (const type of ['a', 'b', 'c', 'd']) bus.publish({ type })
    const controller = new AbortController()

    expect(bus.canResume(1)).toBe(true)
    expect(bus.canResume(0)).toBe(false)
    const events = bus.subscribe(controller.signal, { after: 2 })
    bus.publish({ type: 'e' })

    const seen = []
    for (let i = 0; i < 3; i++) seen.push((await events.next()).value)
    expect(seen.map((event) => event?.event.type)).toEqual(['c', 'd', 'e'])
    controller.abort()
  })
})
