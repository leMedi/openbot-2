import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botUser, type BotRuntimeOptions, type BotTool, type ModelProvider, openBotComputer, type Watchdog } from '@openbot/agent'
import { createFakeModel, createFakeProviders, fakeBotComputer, type FakeBotComputer, type FakeProviders, type FakeShellScript } from '@openbot/agent/testing'
import { connectBrowser, connectDesktop, connectScreens, defaultDaemonSocket } from '@openbot/computer'
import { type Orchestrator, type Screens, type ScreenStatus, writeModelSettings } from '@openbot/core'
import { createFakeClock, createFakeComputer, type FakeClock, type FakeComputer, type FakeComputerScript } from '@openbot/core/testing'
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
    onRestart: (listener) => screens.onRestart(listener),
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
  shell?: FakeShellScript
  /** Pages bots' browsers show, by URL. */
  pages?: FakeComputerScript['pages']
  /** Runs bots' tools on this machine's real computer, in `$OPENBOT_HOME`, instead of the fake; for the runtime image. */
  realComputer?: boolean
  /** Uses the real computer as a server outside the runtime image finds it: without the bots' user, so bots can't run. */
  outsideImage?: boolean
  /** Model providers beside the scripted fakes, e.g. pi's built-in ones for evals on real models. */
  modelProviders?: readonly ModelProvider[]
  /** Shorter watchdog timings than Grok's 120 s and 30 s. */
  watchdog?: Watchdog
  /** Answers bots' downloads, e.g. of the https:// images they send each other. */
  fetch?: typeof fetch
  /** Scripts the model before the server starts, e.g. for the runs and queued inputs a restart resumes. */
  script?: (providers: FakeProviders) => void
  /**
   * When and how much bots' histories are compacted; pi-durable's defaults otherwise, which keep a short history
   * verbatim. `{ keepRecentTokens: 1 }` lets `runtime.compact` summarize all but the newest entries.
   */
  compaction?: BotRuntimeOptions['compaction']
  /** Where the server's fake clock starts; the real time by default. Kept across a restart, as the clock moves on. */
  now?: Date
  /** Adds `fake/fake-memory`, scripted apart from the bots' models through `providers.memoryModel`. */
  memoryModel?: boolean
  /**
   * Extracts memory after every run, on `fake/fake-memory` (implied), set as the memory model; off otherwise, so tests
   * script only their bots' runs.
   */
  extraction?: boolean
  /**
   * Consolidates memory nightly at 04:00 in the owner's time zone, on `fake/fake-memory` (implied), set as the memory
   * model; off otherwise, so tests that move the clock across nights script only their bots' runs.
   */
  consolidation?: boolean
}

/**
 * Seam 1: the router called in-process over a temporary database, with scripted model providers and an in-memory
 * computer.
 */
export async function createTestServer(options: TestServerOptions = {}) {
  return open(await mkdtemp(join(tmpdir(), 'openbot-test-')), testSecretKey, options)
}

/** The fakes that outlive a server, as the computer and the time do. */
type KeptFakes = { computer: FakeComputer; botComputer: FakeBotComputer; clock: FakeClock }

async function open(
  dir: string,
  secretKey: string,
  { shell, pages, realComputer, outsideImage, modelProviders = [], script, memoryModel, extraction = false, consolidation = false, compaction, now, ...options }: TestServerOptions,
  kept?: KeptFakes,
) {
  const db = await openDb(join(dir, 'openbot.db'))
  const providers = createFakeProviders({ memoryModel: memoryModel || extraction || consolidation })
  if (extraction || consolidation) await writeModelSettings(db, { memoryModel: providers.memoryModel.ref })
  script?.(providers)
  const home = realComputer ? process.env.OPENBOT_HOME! : join(dir, 'home')
  // The computer outlives the server, as the screen daemon does.
  const computer = kept?.computer ?? createFakeComputer({ pages })
  const botComputer = kept?.botComputer ?? fakeBotComputer(home, shell)
  const clock = kept?.clock ?? createFakeClock(now)
  const screenTickets = new ScreenTickets()
  // The real screens without the test's display offset, so the browser finds each screen's DevTools where it is.
  const realScreens = realComputer ? connectScreens({ socketPath: process.env.OPENBOT_DESKTOPD_SOCKET || defaultDaemonSocket }) : undefined
  const context = await createServerContext({
    db,
    secretKey,
    providers: [...providers.providers, ...modelProviders],
    agentStoragePath: join(dir, 'agent.sqlite'),
    computer: realComputer
      ? openBotComputer({ home })
      : outsideImage
        ? openBotComputer({ home, user: 'openbot-missing' })
        : botComputer,
    browser: realScreens ? connectBrowser({ screens: realScreens }) : computer.browser,
    desktop: realScreens ? connectDesktop({ screens: realScreens, runAs: botUser }) : computer.desktop,
    attachmentsDir: join(dir, 'attachments'),
    screens: realScreens ? testScreens(realScreens) : computer.screens,
    screenTickets,
    compaction,
    clock,
    memoryExtraction: extraction,
    memoryConsolidation: consolidation,
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
    /** The in-memory computer: every screen, browser and desktop call bots made, keyed by bot name; kept across restarts. */
    computer,
    /** Every shell command bots ran, keyed by bot name; kept across restarts. */
    commands: botComputer.commands,
    /** The server's time, standing still until the test moves it forward with `advance` or `advanceTo`. */
    clock,
    /** The server's scheduled jobs; a test may schedule its own. */
    jobs: context.jobs,
    /** The owner's time zone and local times, as scheduled jobs read them. */
    ownerTime: context.ownerTime,
    /** Memory extraction after runs, with `extraction`; `extraction.idle()` waits for those queued. */
    extraction: context.extraction,
    /** Bots' routines; `routines.idle()` waits for the changes and fires asked so far. */
    routines: context.routines,
    /** The fakes, to keep across a restart. */
    kept: { computer, botComputer, clock } satisfies KeptFakes,
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
      await context.jobs.close()
      await context.routines.close()
      context.stopSyncingScreens()
      context.rounds.close()
      await context.runtime.close()
      await context.extraction.close()
      db.$client.close()
    },
    /** Closes the database and deletes the data. */
    async close() {
      for (const http of streamServers.splice(0)) http.close()
      await context.jobs.close()
      await context.routines.close()
      context.stopSyncingScreens()
      await computer.close()
      context.rounds.close()
      await context.runtime.close()
      await context.extraction.close()
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
  return open(server.dataDir, secretKey, options, server.kept)
}
