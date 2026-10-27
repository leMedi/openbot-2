import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botUser, type BotTool, type ModelProvider, openBotComputer, type Watchdog } from '@openbot/agent'
import { createFakeModel, createFakeProviders, fakeBotComputer } from '@openbot/agent/testing'
import { connectBrowser, connectDesktop, connectScreens, defaultDaemonSocket } from '@openbot/computer'
import type { Orchestrator, Screens, ScreenStatus } from '@openbot/core'
import { createFakeComputer, type FakeComputer, type FakeComputerScript } from '@openbot/core/testing'
import { openDb } from '@openbot/db'
import { createRouterClient } from '@orpc/server'
import { createServerContext } from '../context.ts'
import { handleScreenUpgrade, ScreenTickets } from '../screen-stream.ts'
import { handleApiRequest } from '../http.ts'
import { router } from '../router.ts'

const testSecretKey = 'test-secret-key-that-is-long-enough'

/** Where a test's screens start on the real computer, clear of the dev instance's bots' displays. */
const testDisplayOffset = 500

/**
 * The real computer's screens as a test server sees them: its bots' displays moved up by `testDisplayOffset`, and only
 * those screens listed, so the test never touches (or stops) the screens of the instance it runs beside.
 */
function testScreens(screens: Screens): Screens {
  return {
    start: async (bot) => fromTest(await screens.start({ ...bot, display: bot.display + testDisplayOffset })),
    stop: (bot) => screens.stop(bot),
    status: async (bot) => fromTest(await screens.status(bot)),
    list: async () => (await screens.list()).filter((screen) => (screen.display ?? 0) > testDisplayOffset).map(fromTest),
  }
}

function fromTest<T extends ScreenStatus>(status: T): T {
  return { ...status, display: status.display === null ? null : status.display - testDisplayOffset }
}

export type TestServerOptions = {
  /** Replaces the allow-all orchestrator, e.g. with one that denies. */
  orchestrator?: Orchestrator
  /** Tools bots get beyond the built-in ones. */
  tools?: BotTool[]
  /** Results of bots' shell commands; empty successes otherwise. */
  shell?: FakeComputerScript['shell']
  /** Pages bots' browsers show, by URL. */
  pages?: FakeComputerScript['pages']
  /** Runs bots' tools on this machine's real computer, in `$OPENBOT_HOME`, instead of the fake; for the runtime image. */
  realComputer?: boolean
  /** Model providers beside the scripted fakes, e.g. pi's built-in ones for evals on real models. */
  modelProviders?: readonly ModelProvider[]
  /** Shorter watchdog timings than Grok's 120 s and 30 s. */
  watchdog?: Watchdog
}

/**
 * Seam 1: the router called in-process over a temporary database, with scripted model providers and an in-memory
 * computer.
 */
export async function createTestServer(options: TestServerOptions = {}) {
  return open(await mkdtemp(join(tmpdir(), 'openbot-test-')), testSecretKey, options)
}

async function open(dir: string, secretKey: string, { shell, pages, realComputer, modelProviders = [], ...options }: TestServerOptions, kept?: FakeComputer) {
  const db = await openDb(join(dir, 'openbot.db'))
  const providers = createFakeProviders()
  // The computer outlives the server, as the screen daemon does.
  const computer = kept ?? createFakeComputer({ shell, pages })
  const screenTickets = new ScreenTickets()
  const home = realComputer ? process.env.OPENBOT_HOME! : join(dir, 'home')
  // The real screens without the test's display offset, so the browser finds each screen's DevTools where it is.
  const realScreens = realComputer ? connectScreens({ socketPath: process.env.OPENBOT_DESKTOPD_SOCKET || defaultDaemonSocket }) : undefined
  const context = await createServerContext({
    db,
    secretKey,
    providers: [...providers.providers, ...modelProviders],
    agentStoragePath: join(dir, 'agent.sqlite'),
    computer: realComputer ? openBotComputer({ home }) : fakeBotComputer(computer, home),
    browser: realScreens ? connectBrowser({ screens: realScreens }) : computer.browser,
    desktop: realScreens ? connectDesktop({ screens: realScreens, runAs: botUser }) : computer.desktop,
    attachmentsDir: join(dir, 'attachments'),
    screens: realScreens ? testScreens(realScreens) : computer.screens,
    screenTickets,
    ...options,
  })
  await context.screensSynced
  const streamServers: Server[] = []
  const client = createRouterClient(router, { context })

  return {
    dataDir: dir,
    db,
    client,
    model: createFakeModel(),
    /** The agent runtime, e.g. to wake a bot in the background lane as a routine would. */
    runtime: context.runtime,
    /** Group chats' rounds, e.g. to wait for the members to finish answering. */
    rounds: context.rounds,
    /** The scripted providers behind the API, and their sign-ins. */
    providers,
    /** pi's model collection the runtime uses, with auth resolved through the credential store. */
    models: context.providers.models,
    /** The in-memory computer: every screen and shell command bots used, keyed by bot name; kept across restarts. */
    computer,
    /** The bots' home, a temporary folder: `shared/`, `bots/<id>/`. */
    home,
    /** An HTTP request against the API, e.g. `fetch('/api/health')`. */
    fetch: (path: string, init?: RequestInit) => handleApiRequest(new Request(new URL(path, 'http://openbot.test'), init), context),
    /**
     * Opens a screen stream's `url` (from a ticket) as a WebSocket, through the server's upgrade handler on a real
     * port; resolves with the socket once open, or rejects when refused.
     */
    async openStream(url: string): Promise<WebSocket> {
      const http = createHttpServer((_req, res) => res.writeHead(404).end())
      http.on('upgrade', (req, socket, head) => handleScreenUpgrade(screenTickets, req, socket, head) || socket.destroy())
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
      streamServers.push(http)
      const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}${url}`)
      ws.binaryType = 'arraybuffer'
      return new Promise((resolve, reject) => {
        ws.onopen = () => resolve(ws)
        ws.onerror = () => reject(new Error('The stream was refused'))
      })
    },
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
    /** Connects `providerId` with the API key its usual variable holds in `env`; returns the variable's name. */
    connectProviderFromEnv: (providerId: string, env: Record<string, string | undefined>) => context.providers.connectFromEnv(providerId, env),
    /** One text request to a connected model, e.g. the eval judge's. */
    complete: context.providers.complete.bind(context.providers),
    /** Stops the runtime and closes the database, keeping the data. */
    async shutdown() {
      for (const http of streamServers.splice(0)) http.close()
      context.rounds.close()
      await context.runtime.close()
      db.$client.close()
    },
    /** Closes the database and deletes the data. */
    async close() {
      for (const http of streamServers.splice(0)) http.close()
      await computer.close()
      context.rounds.close()
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
  return open(server.dataDir, secretKey, options, server.computer)
}
