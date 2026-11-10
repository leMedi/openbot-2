import { describe, expect, it } from 'vitest'
import { addressChange } from './change.ts'

const current = { url: 'http://192.168.1.20:3000', instanceId: 'home', setUp: true }

describe('editing the address in Settings → Instance', () => {
  it('switches silently when the new address is the same instance', () => {
    expect(addressChange(current, { kind: 'connected', url: 'https://box.tail1234.ts.net', instanceId: 'home', setUp: true })).toEqual({
      kind: 'sameInstance',
      instance: { url: 'https://box.tail1234.ts.net', instanceId: 'home', setUp: true },
    })
  })

  it('asks first when another instance answers, keeping whether it is set up', () => {
    expect(addressChange(current, { kind: 'connected', url: 'http://10.0.0.5:3000', instanceId: 'office', setUp: false })).toEqual({
      kind: 'otherInstance',
      instance: { url: 'http://10.0.0.5:3000', instanceId: 'office', setUp: false },
    })
  })

  it('changes nothing when the address is the one in use', () => {
    expect(addressChange(current, { kind: 'connected', url: 'http://192.168.1.20:3000', instanceId: 'home', setUp: true })).toEqual({ kind: 'unchanged' })
  })

  it('keeps the current address when the new one fails or is too far apart in version', () => {
    const failure = { kind: 'refused' } as const
    expect(addressChange(current, { kind: 'failed', url: 'http://10.0.0.5:3000', failure })).toEqual({ kind: 'failed', url: 'http://10.0.0.5:3000', failure })
    expect(addressChange(current, { kind: 'instanceTooOld', url: 'http://10.0.0.5:3000' })).toEqual({ kind: 'instanceTooOld', url: 'http://10.0.0.5:3000' })
    expect(addressChange(current, { kind: 'appTooOld', url: 'http://10.0.0.5:3000' })).toEqual({ kind: 'appTooOld', url: 'http://10.0.0.5:3000' })
  })
})
