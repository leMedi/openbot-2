import { describe, expect, it } from 'vitest'
import { type AvatarFiles, AvatarCache, type CachedBot } from './avatar-cache.ts'

/** The app group's avatars folder, in memory: each bot's PNG (as base64) and the manifest. */
function fakeFiles(): AvatarFiles & { avatars: Map<string, string>; manifest: Record<string, string> | undefined } {
  const files = {
    avatars: new Map<string, string>(),
    manifest: undefined as Record<string, string> | undefined,
    readManifest: () => files.manifest,
    writeManifest: (manifest: Record<string, string>) => void (files.manifest = { ...manifest }),
    writeAvatar: (botId: string, png: string) => void files.avatars.set(botId, png),
    removeAvatar: (botId: string) => void files.avatars.delete(botId),
    clear: () => {
      files.avatars.clear()
      files.manifest = undefined
    },
  }
  return files
}

const rex: CachedBot = { id: 'rex', avatarStyle: 'critter', avatarShape: 'blob', avatarColor: 'blue' }
const ana: CachedBot = { id: 'ana', avatarStyle: 'bauhaus', avatarShape: 'hex', avatarColor: 'red' }

/** Draws a bot as `id:colour`, counting the drawings. */
function fakeRender() {
  const drawn: string[] = []
  return { drawn, render: async (bot: CachedBot) => (drawn.push(bot.id), `${bot.id}:${bot.avatarColor}`) }
}

describe("the notifications' avatar cache", () => {
  it('keeps a drawing of each bot for the notification service extension', async () => {
    const files = fakeFiles()
    const { render } = fakeRender()
    await new AvatarCache({ files, render }).sync([rex, ana])
    expect(Object.fromEntries(files.avatars)).toEqual({ rex: 'rex:blue', ana: 'ana:red' })
  })

  it("redraws only a bot whose avatar changed, also after the app's restart", async () => {
    const files = fakeFiles()
    const first = fakeRender()
    await new AvatarCache({ files, render: first.render }).sync([rex, ana])

    const later = fakeRender()
    await new AvatarCache({ files, render: later.render }).sync([{ ...rex, avatarColor: 'green' }, ana])
    expect(later.drawn).toEqual(['rex'])
    expect(files.avatars.get('rex')).toBe('rex:green')
  })

  it('drops a deleted bot', async () => {
    const files = fakeFiles()
    const cache = new AvatarCache({ files, render: fakeRender().render })
    await cache.sync([rex, ana])
    await cache.sync([rex])
    expect([...files.avatars.keys()]).toEqual(['rex'])
    expect(Object.keys(files.manifest ?? {})).toEqual(['rex'])
  })

  it("tries again later for a bot it couldn't draw, keeping the others", async () => {
    const files = fakeFiles()
    let fail = true
    const render = async (bot: CachedBot) => {
      if (bot.id === 'ana' && fail) throw new Error('no view')
      return `${bot.id}:${bot.avatarColor}`
    }
    const cache = new AvatarCache({ files, render })
    await cache.sync([rex, ana])
    expect([...files.avatars.keys()]).toEqual(['rex'])
    fail = false
    await cache.sync([rex, ana])
    expect(files.avatars.get('ana')).toBe('ana:red')
  })

  it('settles on the latest bots when they change while it draws', async () => {
    const files = fakeFiles()
    const { render } = fakeRender()
    const cache = new AvatarCache({ files, render })
    void cache.sync([rex, ana])
    await cache.sync([{ ...ana, avatarColor: 'violet' }])
    expect(Object.fromEntries(files.avatars)).toEqual({ ana: 'ana:violet' })
  })

  it('is emptied when the phone leaves the instance, and a drawing under way stops', async () => {
    const files = fakeFiles()
    const cache = new AvatarCache({ files, render: fakeRender().render })
    await cache.sync([rex])
    const late = cache.sync([rex, ana])
    cache.clear()
    await late
    expect(files.avatars.size).toBe(0)
    expect(files.manifest).toBeUndefined()
  })
})
