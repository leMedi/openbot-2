import type { StampedEvent } from '@openbot/api-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer, type TestServerOptions } from './testing/harness.ts'

const servers: TestServer[] = []
const subscriptions: AbortController[] = []
afterEach(async () => {
  for (const controller of subscriptions.splice(0)) controller.abort()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function start(options: TestServerOptions = {}) {
  const server = await createTestServer(options)
  servers.push(server)
  return server
}

describe("the owner's time zone", () => {
  it('is not set on a new instance', async () => {
    const server = await start()

    expect(await server.client.general.getSettings()).toEqual({ timeZone: null })
  })

  it("is set from the browser's on first visit", async () => {
    const server = await start()

    const settings = await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' })

    expect(settings).toEqual({ timeZone: 'Europe/Paris' })
    expect(await server.client.general.getSettings()).toEqual({ timeZone: 'Europe/Paris' })
  })

  it("is never overwritten by a browser's after that", async () => {
    const server = await start()
    await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' })

    const settings = await server.client.general.detectTimeZone({ timeZone: 'Asia/Tokyo' })

    expect(settings).toEqual({ timeZone: 'Europe/Paris' })
    expect(await server.client.general.getSettings()).toEqual({ timeZone: 'Europe/Paris' })
  })

  it('is changed by the owner in Settings → General, after it was detected', async () => {
    const server = await start()
    await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' })

    const settings = await server.client.general.updateSettings({ timeZone: 'Asia/Tokyo' })

    expect(settings).toEqual({ timeZone: 'Asia/Tokyo' })
    expect(await server.client.general.getSettings()).toEqual({ timeZone: 'Asia/Tokyo' })
    await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' })
    expect(await server.client.general.getSettings()).toEqual({ timeZone: 'Asia/Tokyo' })
  })

  it('is kept spelled as the server knows it', async () => {
    const server = await start()

    expect(await server.client.general.updateSettings({ timeZone: 'utc' })).toEqual({ timeZone: 'UTC' })
  })

  it.each(['Mars/Olympus_Mons', '+01:00', 'Paris'])('refuses %s, which is not an IANA time zone', async (timeZone) => {
    const server = await start()
    await server.client.general.updateSettings({ timeZone: 'Europe/Paris' })

    await expect(server.client.general.updateSettings({ timeZone })).rejects.toThrow(/isn't a known IANA time zone/)
    await expect(server.client.general.detectTimeZone({ timeZone })).rejects.toThrow(/isn't a known IANA time zone/)
    expect(await server.client.general.getSettings()).toEqual({ timeZone: 'Europe/Paris' })
  })

  it('refuses an invalid zone a browser detects, leaving none set', async () => {
    const server = await start()

    await expect(server.client.general.detectTimeZone({ timeZone: 'Mars/Olympus_Mons' })).rejects.toThrow(/isn't a known IANA time zone/)
    expect(await server.client.general.getSettings()).toEqual({ timeZone: null })
  })
})

describe('a change of time zone', () => {
  /** The time zone changes a tab sees, once its stream has caught up with a marker change. */
  async function changesSeen(server: TestServer, act: () => Promise<unknown>) {
    const controller = new AbortController()
    subscriptions.push(controller)
    const stream = await server.client.events(undefined, { signal: controller.signal })
    await stream.next() // hello
    await act()
    const seen: string[] = []
    for (;;) {
      const { value } = (await stream.next()) as { value: StampedEvent }
      if (value.event.type !== 'timeZone.updated') continue
      if (value.event.timeZone === 'Pacific/Auckland') return seen
      seen.push(value.event.timeZone)
    }
  }

  it('is published when the time zone is detected or changed, and only then', async () => {
    const server = await start()

    const seen = await changesSeen(server, async () => {
      await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' })
      await server.client.general.detectTimeZone({ timeZone: 'Asia/Tokyo' })
      await server.client.general.updateSettings({ timeZone: 'Europe/Paris' })
      await server.client.general.updateSettings({ timeZone: 'Asia/Tokyo' })
      await server.client.general.updateSettings({ timeZone: 'Pacific/Auckland' })
    })

    expect(seen).toEqual(['Europe/Paris', 'Asia/Tokyo'])
  })

  it("moves a daily job that follows the owner's time zone to its new local time", async () => {
    const server = await start({ now: new Date('2026-10-28T12:00:00Z') })
    await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' })
    const fired: string[] = []
    server.jobs.daily('consolidation', { at: '04:00', timeZone: server.ownerTime.timeZone }, async () => {
      fired.push(new Date(server.clock.now()).toISOString())
    })
    await server.jobs.scheduled()

    await server.client.general.updateSettings({ timeZone: 'Asia/Tokyo' })
    await server.jobs.scheduled()
    await server.clock.advanceTo(new Date('2026-10-30T12:00:00Z'))

    // 04:00 in Tokyo (UTC+9) from the day of the change, never 04:00 in Paris.
    expect(fired).toEqual(['2026-10-28T19:00:00.000Z', '2026-10-29T19:00:00.000Z'])
  })

  it('made while the job runs schedules its next run once, in the new time zone', async () => {
    const server = await start({ now: new Date('2026-10-28T12:00:00Z') })
    await server.client.general.detectTimeZone({ timeZone: 'Europe/Paris' })
    const fired: string[] = []
    server.jobs.daily('consolidation', { at: '04:00', timeZone: server.ownerTime.timeZone }, async () => {
      fired.push(new Date(server.clock.now()).toISOString())
      await server.client.general.updateSettings({ timeZone: 'Asia/Tokyo' })
    })
    await server.jobs.scheduled()

    await server.clock.advanceTo(new Date('2026-10-30T12:00:00Z'))

    // 04:00 in Paris (UTC+1), then 04:00 in Tokyo (UTC+9) each day, once.
    expect(fired).toEqual(['2026-10-29T03:00:00.000Z', '2026-10-29T19:00:00.000Z'])
  })
})

describe("the owner's local time", () => {
  it('is turned into an instant in their time zone', async () => {
    const server = await start()
    await server.client.general.updateSettings({ timeZone: 'America/New_York' })

    expect(new Date(await server.ownerTime.instant('2026-10-29T09:00')).toISOString()).toBe('2026-10-29T13:00:00.000Z')
    expect(new Date(await server.ownerTime.instant('2026-12-24T18:30')).toISOString()).toBe('2026-12-24T23:30:00.000Z')
  })

  it('is read in UTC until a time zone is detected', async () => {
    const server = await start()

    expect(new Date(await server.ownerTime.instant('2026-10-29T09:00')).toISOString()).toBe('2026-10-29T09:00:00.000Z')
  })

  it('skipped by daylight saving time is moved past the gap, as the clocks were', async () => {
    const server = await start()
    await server.client.general.updateSettings({ timeZone: 'America/New_York' })

    // 02:30 doesn't exist on March 14th, 2027 in New York: clocks go from 02:00 EST to 03:00 EDT, so 03:30 EDT.
    expect(new Date(await server.ownerTime.instant('2027-03-14T02:30')).toISOString()).toBe('2027-03-14T07:30:00.000Z')
  })

  it('that happens twice as daylight saving time ends is the first of the two', async () => {
    const server = await start()
    await server.client.general.updateSettings({ timeZone: 'America/New_York' })

    // 01:30 on November 1st, 2026 in New York happens in EDT (05:30Z), then again in EST (06:30Z).
    expect(new Date(await server.ownerTime.instant('2026-11-01T01:30')).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('must be a real date and time of day', async () => {
    const server = await start()

    await expect(server.ownerTime.instant('2026-02-30T09:00')).rejects.toThrow(/isn't a local date and time/)
    await expect(server.ownerTime.instant('2026-10-29 9am' as never)).rejects.toThrow(/isn't a local date and time/)
  })
})
