import { describe, expect, it } from 'vitest'
import { failureMessage } from './messages.ts'

describe('what a connect failure says', () => {
  it('hints at Tailscale for a name not found only on a Tailscale address', () => {
    expect(failureMessage({ kind: 'notFound' }, 'https://box.tail1234.ts.net')).toBe("Can't find box.tail1234.ts.net. Is Tailscale on on this phone?")
    expect(failureMessage({ kind: 'notFound' }, 'http://100.84.12.7:3000')).toBe("Can't find 100.84.12.7. Is Tailscale on on this phone?")
    expect(failureMessage({ kind: 'notFound' }, 'http://openbot.local:3000')).toBe("Can't find openbot.local.")
    expect(failureMessage({ kind: 'timeout' }, 'http://box.tail1234.ts.net:3000')).toBe(
      'No answer from box.tail1234.ts.net. Is this phone on the same network or VPN as OpenBot?',
    )
  })

  it('names the port nothing listens on', () => {
    expect(failureMessage({ kind: 'refused' }, 'http://192.168.1.20:3000')).toBe('192.168.1.20 is up but nothing is listening on port 3000.')
    expect(failureMessage({ kind: 'refused' }, 'https://192.168.1.20')).toBe('192.168.1.20 is up but nothing is listening on port 443.')
  })

  it('says the rest in their own words', () => {
    expect(failureMessage({ kind: 'certificate' }, 'https://box.local')).toBe("box.local's certificate isn't trusted.")
    expect(failureMessage({ kind: 'notOpenBot' }, 'http://box.local:3000')).toBe("That address answered, but it isn't OpenBot.")
    expect(failureMessage({ kind: 'localNetwork' }, 'http://box.local:3000')).toBe("OpenBot isn't allowed on your local network.")
    expect(failureMessage({ kind: 'other', detail: 'An SSL error has occurred.' }, 'https://box.local')).toBe("Couldn't reach box.local: An SSL error has occurred.")
  })
})
