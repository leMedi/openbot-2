import { afterEach, describe, expect, it } from 'vitest'
import { devInstanceAddress } from './instance.ts'

describe("the dev build's instance address", () => {
  afterEach(() => void delete process.env.EXPO_PUBLIC_OPENBOT_URL)

  it('is the origin of the URL set, http or https, the app adding /api itself', () => {
    process.env.EXPO_PUBLIC_OPENBOT_URL = ' http://box.tail1234.ts.net:3000/ '
    expect(devInstanceAddress()).toBe('http://box.tail1234.ts.net:3000')
    process.env.EXPO_PUBLIC_OPENBOT_URL = 'https://box.tail1234.ts.net/api'
    expect(devInstanceAddress()).toBe('https://box.tail1234.ts.net')
  })

  it('is unset when the variable is empty or not an http(s) URL', () => {
    expect(devInstanceAddress()).toBeUndefined()
    for (const value of ['', '192.168.1.20:3000', 'ftp://box.local']) {
      process.env.EXPO_PUBLIC_OPENBOT_URL = value
      expect(devInstanceAddress()).toBeUndefined()
    }
  })
})
