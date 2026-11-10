import { describe, expect, it } from 'vitest'
import { listeningClock, maxDictationMs } from './clock.ts'

describe('the Listening… bar’s clock', () => {
  it('allows 2 minutes', () => {
    expect(maxDictationMs).toBe(120_000)
  })

  it('shows the time spoken so far', () => {
    expect(listeningClock(0)).toEqual({ time: '0:00', secondsLeft: undefined, over: false })
    expect(listeningClock(7_900)).toEqual({ time: '0:07', secondsLeft: undefined, over: false })
    expect(listeningClock(65_000)).toEqual({ time: '1:05', secondsLeft: undefined, over: false })
  })

  it('counts down the last 10 seconds', () => {
    expect(listeningClock(109_999).secondsLeft).toBeUndefined()
    expect(listeningClock(110_000).secondsLeft).toBe(10)
    expect(listeningClock(110_001).secondsLeft).toBe(10)
    expect(listeningClock(119_200).secondsLeft).toBe(1)
  })

  it('is over at 2 minutes', () => {
    expect(listeningClock(120_000)).toEqual({ time: '2:00', secondsLeft: 0, over: true })
    expect(listeningClock(121_500).over).toBe(true)
  })
})
