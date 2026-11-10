import { describe, expect, it } from 'vitest'
import { candidateUrls } from './address.ts'

describe('the addresses tried for what the owner typed', () => {
  it('tries https, then http on port 3000, for a bare name or IP', () => {
    expect(candidateUrls('192.168.1.20')).toEqual(['https://192.168.1.20', 'http://192.168.1.20:3000'])
    expect(candidateUrls('box.tail1234.ts.net')).toEqual(['https://box.tail1234.ts.net', 'http://box.tail1234.ts.net:3000'])
  })

  it('keeps a typed port for both schemes', () => {
    expect(candidateUrls('openbot.local:3000')).toEqual(['https://openbot.local:3000', 'http://openbot.local:3000'])
    expect(candidateUrls('192.168.1.38:3100')).toEqual(['https://192.168.1.38:3100', 'http://192.168.1.38:3100'])
  })

  it('takes a typed scheme as it is, adding port 3000 to http without a port', () => {
    expect(candidateUrls('https://box.tail1234.ts.net')).toEqual(['https://box.tail1234.ts.net'])
    expect(candidateUrls('HTTP://192.168.1.20')).toEqual(['http://192.168.1.20:3000'])
    expect(candidateUrls('http://192.168.1.20:8080')).toEqual(['http://192.168.1.20:8080'])
    expect(candidateUrls('https://box.local:8443')).toEqual(['https://box.local:8443'])
  })

  it('ignores a typed path, query and spaces around it', () => {
    expect(candidateUrls('  http://192.168.1.20:3000/chats/abc?x=1#y  ')).toEqual(['http://192.168.1.20:3000'])
    expect(candidateUrls('openbot.local:3000/api/')).toEqual(['https://openbot.local:3000', 'http://openbot.local:3000'])
  })

  it('lowercases the name', () => {
    expect(candidateUrls('OpenBot.Local')).toEqual(['https://openbot.local', 'http://openbot.local:3000'])
  })

  it('accepts a bracketed IPv6 address', () => {
    expect(candidateUrls('[fd7a:115c::1]:3000')).toEqual(['https://[fd7a:115c::1]:3000', 'http://[fd7a:115c::1]:3000'])
  })

  it('tries nothing for something that is not an address', () => {
    for (const input of ['', '   ', 'not an address', 'ftp://box.local', 'http://', 'box.local:99999', 'box.local:abc']) {
      expect(candidateUrls(input), input).toEqual([])
    }
  })
})
