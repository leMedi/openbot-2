import { afterEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from './testing/harness.ts'

const servers: TestServer[] = []
async function start() {
  const server = await createTestServer()
  servers.push(server)
  return server
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const iphone = { expoPushToken: 'ExponentPushToken[iphone-aaaa]', name: "Mehdi's iPhone", platform: 'ios' as const }
const pixel = { expoPushToken: 'ExponentPushToken[pixel-bbbb]', name: 'Pixel 9', platform: 'android' as const }

describe('devices', () => {
  it('registers a phone, with both notification switches on', async () => {
    const server = await start()

    const device = await server.client.devices.register(iphone)

    expect(device).toEqual({
      id: expect.any(String),
      name: "Mehdi's iPhone",
      platform: 'ios',
      messages: true,
      needsYou: true,
      createdAt: expect.any(Number),
    })
    expect(await server.client.devices.list()).toEqual([device])
  })

  it('updates the row when the same token registers again, keeping its switches', async () => {
    const server = await start()
    const first = await server.client.devices.register(iphone)
    await server.client.devices.setSwitches({ deviceId: first.id, messages: false })

    const again = await server.client.devices.register({ ...iphone, name: 'iPhone 17' })

    expect(again).toEqual({ ...first, name: 'iPhone 17', messages: false })
    expect(await server.client.devices.list()).toEqual([again])
  })

  it('keeps several phones; unregistering one by its token or removing one by id deletes its row', async () => {
    const server = await start()
    const phone = await server.client.devices.register(iphone)
    const android = await server.client.devices.register(pixel)
    const ipad = await server.client.devices.register({ expoPushToken: 'ExponentPushToken[ipad-cccc]', name: 'iPad', platform: 'ios' })
    expect(await server.client.devices.list()).toEqual([phone, android, ipad])

    await server.client.devices.unregister({ expoPushToken: pixel.expoPushToken })
    expect(await server.client.devices.list()).toEqual([phone, ipad])

    await server.client.devices.remove({ deviceId: phone.id })
    expect(await server.client.devices.list()).toEqual([ipad])
  })

  it("unregistering a token that isn't registered does nothing, and removing an unknown phone is not found", async () => {
    const server = await start()
    const phone = await server.client.devices.register(iphone)

    await server.client.devices.unregister({ expoPushToken: pixel.expoPushToken })
    await expect(server.client.devices.remove({ deviceId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(server.client.devices.setSwitches({ deviceId: 'nope', messages: false })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await server.client.devices.list()).toEqual([phone])
  })

  it("stores each phone's two switches and returns them", async () => {
    const server = await start()
    const phone = await server.client.devices.register(iphone)
    const android = await server.client.devices.register(pixel)

    expect(await server.client.devices.setSwitches({ deviceId: phone.id, messages: false })).toMatchObject({ messages: false, needsYou: true })
    expect(await server.client.devices.setSwitches({ deviceId: android.id, needsYou: false })).toMatchObject({ messages: true, needsYou: false })
    expect(await server.client.devices.setSwitches({ deviceId: phone.id, needsYou: false })).toMatchObject({ messages: false, needsYou: false })

    expect(await server.client.devices.list()).toEqual([
      { ...phone, messages: false, needsYou: false },
      { ...android, messages: true, needsYou: false },
    ])
  })

  it('refuses a token that is not an Expo push token, and a blank name', async () => {
    const server = await start()

    await expect(server.client.devices.register({ ...iphone, expoPushToken: 'abc' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(server.client.devices.register({ ...iphone, name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(await server.client.devices.list()).toEqual([])
  })
})
