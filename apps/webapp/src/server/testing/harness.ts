import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BotTool, openBotComputer } from '@openbot/agent'
import { createFakeModel, createFakeProviders, fakeBotComputer } from '@openbot/agent/testing'
import type { Orchestrator } from '@openbot/core'
import { createFakeComputer, type FakeComputerScript } from '@openbot/core/testing'
import { openDb } from '@openbot/db'
import { createRouterClient } from '@orpc/server'
import { createServerContext } from '../context.ts'
import { handleApiRequest } from '../http.ts'
import { router } from '../router.ts'

const testSecretKey = 'test-secret-key-that-is-long-enough'

export type TestServerOptions = {
  /** Replaces the allow-all orchestrator, e.g. with one that denies. */
  orchestrator?: Orchestrator
  /** Tools bots get beyond the built-in ones. */
  tools?: BotTool[]
  /** Results of bots' shell commands; empty successes otherwise. */
  shell?: FakeComputerScript['shell']
  /** Runs bots' tools on this machine's real computer, in `$OPENBOT_HOME`, instead of the fake; for the runtime image. */
  realComputer?: boolean
}

/**
 * Seam 1: the router called in-process over a temporary database, with scripted model providers and an in-memory
 * computer.
 */
export async function createTestServer(options: TestServerOptions = {}) {
  return open(await mkdtemp(join(tmpdir(), 'openbot-test-')), testSecretKey, options)
}

async function open(dir: string, secretKey: string, { shell, realComputer, ...options }: TestServerOptions) {
  const db = await openDb(join(dir, 'openbot.db'))
  const providers = createFakeProviders()
  const computer = createFakeComputer({ shell })
  const home = realComputer ? process.env.OPENBOT_HOME! : join(dir, 'home')
  const context = await createServerContext({
    db,
    secretKey,
    providers: providers.providers,
    agentStoragePath: join(dir, 'agent.sqlite'),
    computer: realComputer ? openBotComputer({ home }) : fakeBotComputer(computer, home),
    attachmentsDir: join(dir, 'attachments'),
    ...options,
  })
  const client = createRouterClient(router, { context })

  return {
    dataDir: dir,
    db,
    client,
    model: createFakeModel(),
    /** The scripted providers behind the API, and their sign-ins. */
    providers,
    /** pi's model collection the runtime uses, with auth resolved through the credential store. */
    models: context.providers.models,
    /** The in-memory computer: every shell command bots ran, keyed by bot name. */
    computer,
    /** The bots' home, a temporary folder: `shared/`, `bots/<id>/`. */
    home,
    /** An HTTP request against the API, e.g. `fetch('/api/health')`. */
    fetch: (path: string, init?: RequestInit) => handleApiRequest(new Request(new URL(path, 'http://openbot.test'), init), context),
    /** Connects the `fake` provider with an API key, as the owner would in Settings → Providers. */
    async connectProvider(key = 'sk-fake-123') {
      const steps = await client.providers.connect({ providerId: 'fake', method: 'api_key' })
      let signInId = ''
      for await (const step of steps) {
        if (step.type === 'started') signInId = step.signInId
        if (step.type === 'prompt') await client.providers.answer({ signInId, promptId: step.promptId, value: key })
        if (step.type === 'failed') throw new Error(step.message)
      }
    },
    /** Stops the runtime and closes the database, keeping the data. */
    async shutdown() {
      await context.runtime.close()
      db.$client.close()
    },
    /** Closes the database and deletes the data. */
    async close() {
      await context.runtime.close()
      db.$client.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export type TestServer = Awaited<ReturnType<typeof open>>

/**
 * Simulates a server restart: closes `server` without deleting its data and starts a new one on it, optionally with
 * another secret key (as when the owner loses theirs).
 */
export async function restartTestServer(
  server: TestServer,
  { secretKey = testSecretKey, ...options }: TestServerOptions & { secretKey?: string } = {},
): Promise<TestServer> {
  await server.shutdown()
  return open(server.dataDir, secretKey, options)
}
