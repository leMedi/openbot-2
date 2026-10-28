import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type FakeMcpServer, type FakeMcpTool, startFakeMcpServer } from '@openbot/agent/testing'
import type { SignInStep } from '@openbot/api-contract'
import { expect } from 'vitest'
import type { TestServer } from './harness.ts'

/** What the fixtures below made, removed by `closePluginFixtures`. */
const made: (() => Promise<void>)[] = []

/** Stops the fake servers and deletes the catalogs made since the last call; for a test file's `afterEach`. */
export async function closePluginFixtures() {
  await Promise.all(made.splice(0).map((close) => close()))
}

/** A plugin folder's files, by path from its root; objects are written as JSON. */
export type FixturePlugin = Record<string, string | object>

/** Writes a catalog of `plugins`, by folder name, into `into` or a new temporary folder; returns it. */
export async function writeCatalog(plugins: Record<string, FixturePlugin>, into?: string): Promise<string> {
  const catalog = into ?? (await mkdtemp(join(tmpdir(), 'openbot-catalog-')))
  if (!into) made.push(() => rm(catalog, { recursive: true, force: true }))
  await rm(catalog, { recursive: true, force: true })
  for (const [folder, files] of Object.entries(plugins)) {
    for (const [path, content] of Object.entries(files)) {
      const file = join(catalog, folder, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
    }
  }
  return catalog
}

/**
 * A hosted plugin `name` served by a fake MCP server, offering `tools`, behind its own OAuth authorization server;
 * returns both.
 */
export async function hostedPlugin(name = 'notes', tools: FakeMcpTool[] = []) {
  const fake = await startFakeMcpServer({ tools })
  made.push(() => fake.close())
  const plugin: FixturePlugin = {
    '.claude-plugin/plugin.json': { name, displayName: 'Notes', description: 'Your notes workspace', icon: './logo.svg' },
    '.mcp.json': { mcpServers: { [name]: { type: 'http', url: fake.url } } },
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  }
  return { fake, plugin }
}

/** The instance as the owner opens it on their private network, over plain HTTP: sign-ins end in a pasted URL. */
export const privateOrigin = 'http://192.168.1.25:3000'

/**
 * Connects an account of `name` as the owner would from the page at `origin`, signing in on the fake as `user`: the
 * browser returns to the callback route, which goes back to the plugin, or the owner pastes the URL it ends on.
 * Returns every step. With `requestId`, it connects from that bot's plugin request card, granting the bot the account.
 */
export async function connectAccount(
  server: TestServer,
  fake: FakeMcpServer,
  { name = 'notes', origin = privateOrigin, user = 'owner', requestId }: { name?: string; origin?: string; user?: string; requestId?: string } = {},
) {
  const steps: SignInStep[] = []
  let signInId = ''
  let endsOn = ''
  for await (const step of await server.client.plugins.connect({ name, origin, ...(requestId && { requestId }) })) {
    steps.push(step)
    if (step.type === 'started') signInId = step.signInId
    if (step.type === 'auth_url') {
      endsOn = await fake.authorize(step.url, { user })
      if (endsOn.startsWith(origin)) {
        const back = await server.fetch(endsOn.slice(origin.length), { redirect: 'manual' })
        expect(back.status).toBe(303)
        expect(back.headers.get('location')).toBe(`/settings/plugins/${name}`)
      }
    }
    if (step.type === 'prompt') await server.client.plugins.answer({ signInId, promptId: step.promptId, value: endsOn })
  }
  return steps
}
