import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelProvider } from '@openbot/agent'
import {
  answeringProvider,
  callsTools,
  endsSilently,
  says,
  type ExecResult,
  type FakeMcpServer,
  type FakeTurn,
  recordingTool,
  startFakeMcpServer,
} from '@openbot/agent/testing'
import type { BotInfo, FactInfo, MessageInfo } from '@openbot/api-contract'
import type { ComputerBot } from '@openbot/core'
import { createTestServer, type TestServer } from '@openbot/webapp/testing'
import { type AssertionResult, checkAssertion } from './assertions.ts'
import { judgeRequest, parseVerdicts, type RubricResult } from './judge.ts'
import type { RunResult } from './report.ts'
import { accountSlug, type FakePlugin, type FauxTurn, type Scenario, type ScriptStep } from './scenario.ts'
import type { ChatMessage, RunRecord } from './run-record.ts'

/**
 * The models a run uses. `faux`: every bot on the scripted fake model, playing the scenario's `faux` turns, and a
 * judge that passes every rubric item; checks the scenario and the pipeline, not a model. `real`: bots on `model` (or
 * their own), judged by `judge`, with providers connected from API keys in `env`.
 */
export type EvalModels =
  | { kind: 'faux' }
  | { kind: 'real'; model: string; judge: string; env: Record<string, string | undefined>; providers: readonly ModelProvider[] }

/** A scenario's run, with what it left behind. */
export type ScenarioRun = RunResult & {
  record: RunRecord
  /** The fake world's side of the run: the shell commands bots ran and what they got back. */
  world: { shell: { bot: string; command: string; stdout: string }[] }
}

export type RunOptions = {
  /** Which run of the scenario this is, from 1. */
  run?: number
  /** How long each owner message may keep the bots busy before the run fails; 5 minutes by default. */
  stepTimeoutMs?: number
}

const fauxModel = 'fake/fake-model'
const fauxJudge = 'eval-judge/model'

/** A judge for faux runs: passes every numbered rubric item it is shown. */
const fauxJudgeProvider = () =>
  answeringProvider('eval-judge', (prompt) => {
    const items = prompt.slice(prompt.lastIndexOf('\nRubric:')).match(/^\d+\./gm) ?? []
    const verdicts = items.map((item) => ({ item: Number.parseInt(item), pass: true, reason: 'The faux judge passes every item' }))
    return JSON.stringify({ verdicts })
  })

/** Silent ends a scripted bot gets after its turns on a real model, so it passes whenever the others make it answer again. */
const scriptedPasses = 20

/**
 * Who pi-durable's compaction summaries are scripted for: its summarizer's prompt says "You are a context
 * summarization assistant.", and the fake routes a request to whoever its prompt says it is.
 */
const summarizer = 'a context summarization assistant'

const toFakeTurn = (turn: FauxTurn): FakeTurn =>
  'tools' in turn ? callsTools(...(turn.tools as Parameters<typeof callsTools>)) : 'say' in turn ? says(turn.say) : endsSilently()

const providerOf = (ref: string) => ref.slice(0, ref.indexOf('/'))

/** What `date` prints at `now` (ms since the epoch). */
const dateOutput = (now: number) => `${new Date(now).toUTCString()}\n`

/** Runs one scenario on a fresh server: sets it up, sends the owner's messages, then checks and judges what happened. */
export async function runScenario(scenario: Scenario, models: EvalModels, { run = 1, stepTimeoutMs = 300_000 }: RunOptions = {}): Promise<ScenarioRun> {
  const shellLog: ScenarioRun['world']['shell'] = []
  // The server's clock starts at the world's and moves only with the script's `advance` steps.
  let now = () => Date.now()
  const shell = (command: string, bot: ComputerBot): ExecResult | undefined => {
    const rule = scenario.world.shell.find((candidate) => new RegExp(candidate.match).test(command))
    const result = rule
      ? { stdout: rule.stdout, stderr: rule.stderr, exitCode: rule.exitCode }
      : scenario.world.clock && /^\s*date\b/.test(command)
        ? { stdout: dateOutput(now()), stderr: '', exitCode: 0 }
        : undefined
    shellLog.push({ bot: bot.name, command, stdout: result?.stdout ?? '' })
    return result
  }
  const plugins = await startPlugins(scenario.world.plugins)
  const server = await createTestServer({
    // The world's plugins only, never the bundled ones' real servers.
    catalog: plugins.catalog,
    shell,
    pages: scenario.world.pages,
    tools: scenario.world.tools.map((tool) => recordingTool(tool.name, 'mcp', tool).tool),
    modelProviders: models.kind === 'faux' ? [fauxJudgeProvider()] : models.providers,
    extraction: scenario.extraction,
    // On real models, memory is extracted on each bot's model; on the faux one, on the faux memory model.
    memoryModel: models.kind === 'faux' && scenario.extraction,
    ...(scenario.world.clock && { now: new Date(scenario.world.clock) }),
    // Forced compactions summarize all but the newest entries, so even a short chat compacts.
    ...(scenario.script.some((step) => 'compact' in step) && { compaction: { keepRecentTokens: 1 } }),
  }).catch(async (error: unknown) => {
    await plugins.close()
    throw error
  })
  now = () => server.clock.now()
  const record: RunRecord = { toolCalls: [], pluginCalls: plugins.calls, chats: {}, memory: [], routines: [] }
  const result = (fields: { assertions?: AssertionResult[]; rubric?: RubricResult[]; error?: string }): ScenarioRun => ({
    scenario: scenario.id,
    run,
    assertions: [],
    rubric: [],
    ...fields,
    record,
    world: { shell: shellLog },
  })

  try {
    const bots = await setUp(server, scenario, models)
    await connectAccounts(server, scenario, plugins, bots)
    const groups = new Map<string, string>()
    let error: string | undefined
    try {
      for (const step of scenario.script) {
        const deadline = Date.now() + stepTimeoutMs
        if ('compact' in step) {
          await compact(server, bots.get(step.compact)!)
          await untilQuiet(server, [...groups.values()], deadline)
          continue
        }
        if ('forget' in step) {
          await forget(server, bots, new RegExp(step.forget, 'i'))
          continue
        }
        if ('decide' in step) {
          await decide(server, bots.get(step.decide)!, step, scenario.world.plugins[step.plugin]!)
          await untilQuiet(server, [...groups.values()], deadline)
          continue
        }
        if ('advance' in step || 'advanceTo' in step) {
          const until = 'advance' in step ? server.clock.now() + step.advance : Date.parse(step.advanceTo)
          await advance(server, [...bots.values()], until, [...groups.values()], deadline)
          continue
        }
        const bot = bots.get(step.to)
        if (bot) {
          await server.client.chats.send({ chatId: bot.chatId, text: step.text })
        } else {
          const group = scenario.groups.find((candidate) => candidate.name === step.to)!
          const chatId = groups.get(group.name)
          if (chatId) await server.client.chats.send({ chatId, text: step.text })
          else {
            const { chat } = await server.client.groups.create({ memberIds: group.members.map((name) => bots.get(name)!.id), text: step.text })
            await server.client.groups.update({ chatId: chat.id, title: group.name })
            groups.set(group.name, chat.id)
          }
        }
        await untilQuiet(server, [...groups.values()], deadline)
      }
    } catch (caught) {
      error = (caught as Error).message
    }

    await collect(server, scenario, bots, groups, record)
    error ??= await runFailures(server, bots, models)
    const assertions = scenario.assertions.map((assertion) => checkAssertion(assertion, record))
    const rubric = scenario.rubric.length ? await judge(server, scenario, record, models.kind === 'faux' ? fauxJudge : models.judge) : []
    return result({ assertions, rubric, error })
  } catch (caught) {
    return result({ error: (caught as Error).message })
  } finally {
    await server.close()
    await plugins.close()
  }
}

/** The instance as the owner opens it on their private network over plain HTTP: a sign-in ends in a pasted URL. */
const privateOrigin = 'http://192.168.1.25:3000'

/**
 * Serves each of the world's plugins from a fake hosted MCP server, its tools answering by the account calling (the
 * fake's user is the account's name) and logging the calls they answer, and writes them as the catalog the server
 * reads: the world's plugins only.
 */
async function startPlugins(plugins: Record<string, FakePlugin>) {
  const catalog = await mkdtemp(join(tmpdir(), 'openbot-eval-catalog-'))
  const calls: RunRecord['pluginCalls'] = []
  const fakes = new Map<string, FakeMcpServer>()
  const close = async () => {
    await Promise.all([...fakes.values()].map((fake) => fake.close()))
    await rm(catalog, { recursive: true, force: true })
  }
  try {
    for (const [name, plugin] of Object.entries(plugins)) {
      const fake = await startFakeMcpServer({
        tools: plugin.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
          call: (args, { user: accountName }) => {
            const result = typeof tool.result === 'string' ? tool.result : (tool.result[accountName] ?? '')
            calls.push({ tool: `mcp__${name}_${accountSlug(plugin, accountName)}__${tool.name}`, account: accountName, args, result })
            return result
          },
        })),
      })
      fakes.set(name, fake)
      await mkdir(join(catalog, name, '.claude-plugin'), { recursive: true })
      await writeFile(join(catalog, name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, displayName: plugin.displayName, description: plugin.description }))
      await writeFile(join(catalog, name, '.mcp.json'), JSON.stringify({ mcpServers: { [name]: { type: 'http', url: fake.url } } }))
    }
  } catch (error) {
    await close()
    throw error
  }
  return { catalog, calls, fakes, close }
}

type Plugins = Awaited<ReturnType<typeof startPlugins>>

/**
 * Connects each plugin's accounts in order, as the owner would by pasting the URL the browser ends on, so they are
 * `account1`, `account2`…; names them, and grants them to their bots.
 */
async function connectAccounts(server: TestServer, scenario: Scenario, plugins: Plugins, bots: Map<string, BotInfo>) {
  for (const [name, plugin] of Object.entries(scenario.world.plugins)) {
    for (const account of plugin.accounts) {
      await connectAccount(server, plugins.fakes.get(name)!, name, account.name)
      const slug = accountSlug(plugin, account.name)
      await server.client.plugins.renameAccount({ name, account: slug, displayName: account.name })
      for (const bot of account.granted) await server.client.plugins.grant({ name, account: slug, botId: bots.get(bot)!.id })
    }
  }
}

/** Connects an account of plugin `name`, signing in on its fake server with the account's name as its user. */
async function connectAccount(server: TestServer, fake: FakeMcpServer, name: string, accountName: string) {
  let signInId = ''
  let endsOn = ''
  for await (const step of await server.client.plugins.connect({ name, origin: privateOrigin })) {
    if (step.type === 'started') signInId = step.signInId
    if (step.type === 'auth_url') endsOn = await fake.authorize(step.url, { user: accountName })
    if (step.type === 'prompt') await server.client.plugins.answer({ signInId, promptId: step.promptId, value: endsOn })
    if (step.type === 'failed') throw new Error(`Connecting ${accountName} to ${name} failed: ${step.message}`)
  }
}

/**
 * The owner decides the bot's newest undecided request for the step's plugin: grants the account the step names, or
 * denies it. Does nothing when there is none: the bot didn't ask, which the scenario's checks catch.
 */
async function decide(server: TestServer, bot: BotInfo, step: Extract<ScriptStep, { decide: string }>, plugin: FakePlugin) {
  const card = (await server.client.chats.messages({ chatId: bot.chatId }))
    .reverse()
    .find((message) => message.card?.type === 'plugin_request' && message.card.plugin === step.plugin && message.card.decision === null)
  if (!card) return
  const decision = 'grant' in step ? { outcome: 'granted' as const, account: accountSlug(plugin, step.grant) } : { outcome: 'denied' as const }
  await server.client.chats.decidePluginRequest({ messageId: card.id, decision })
}

/** Connects the providers, picks the models, scripts the faux turns and creates the bots; returns them by name. */
async function setUp(server: TestServer, scenario: Scenario, models: EvalModels): Promise<Map<string, BotInfo>> {
  // First, so a summary goes to the summarizer whatever the conversation it summarizes says.
  server.providers.scriptFor(summarizer)
  const scripted = (name: string) => models.kind === 'faux' || scenario.bots.some((bot) => bot.name === name && bot.scripted)
  if (models.kind === 'faux' || scenario.bots.some((bot) => bot.scripted) || scenario.script.some((step) => 'compact' in step)) await server.connectProvider()
  for (const [bot, turns] of Object.entries(scenario.faux)) {
    if (!scripted(bot)) continue
    const padding = models.kind === 'faux' ? [] : Array.from({ length: scriptedPasses }, endsSilently)
    server.providers.scriptFor(bot, ...turns.map(toFakeTurn), ...padding)
  }
  if (models.kind === 'faux') {
    for (const answer of scenario.fauxMemory) server.providers.memoryModel.script(says(answer))
  } else {
    const refs = [models.model, models.judge, ...scenario.bots.flatMap((bot) => (bot.model && !bot.scripted ? [bot.model] : []))]
    for (const provider of new Set(refs.map(providerOf))) await server.connectProviderFromEnv(provider, models.env)
  }
  await server.client.models.updateSettings({ defaultModel: models.kind === 'faux' ? fauxModel : models.model })
  const bots = new Map<string, BotInfo>()
  for (const bot of scenario.bots) {
    const created = await server.client.bots.create({
      name: bot.name,
      title: bot.title,
      instructions: bot.instructions,
      avatarShape: 'hex',
      avatarColor: 'blue',
      // On the faux model every bot plays its script; a scripted bot plays it on every model.
      model: models.kind === 'faux' ? null : bot.scripted ? fauxModel : bot.model,
    })
    bots.set(bot.name, created)
  }
  for (const fact of scenario.memory) {
    const added = { tier: fact.tier, text: fact.text, importance: fact.importance }
    if (fact.bot) await server.client.bots.addFact({ botId: bots.get(fact.bot)!.id, ...added })
    else await server.client.sharedMemory.add(added)
  }
  for (const { bot, ...routine } of scenario.routines) await server.client.routines.create({ botId: bots.get(bot)!.id, ...routine })
  return bots
}

/**
 * Compacts the bot's history with a summary that says nothing of the conversation, on whatever model: what the bot
 * knows afterwards comes from its memory and the newest entries the compaction keeps verbatim, not from the summary.
 */
async function compact(server: TestServer, bot: BotInfo) {
  const { model } = (await server.client.bots.list()).find((candidate) => candidate.id === bot.id)!
  server.providers.scriptFor(summarizer, says('The conversation so far is summarized elsewhere.'))
  await server.client.bots.update({ botId: bot.id, model: fauxModel })
  try {
    await server.runtime.compact(bot.id)
  } finally {
    await server.client.bots.update({ botId: bot.id, model })
  }
}

/**
 * Moves the server's clock forward to `until`, stopping at each routine fire on the way until the bots are done with
 * it, so a bot's run happens at the time its routine was due (as `date` says), not at the end of the move.
 */
async function advance(server: TestServer, bots: BotInfo[], until: number, groupChatIds: string[], deadline: number) {
  for (;;) {
    const due = (await Promise.all(bots.map((bot) => server.client.routines.list({ botId: bot.id }))))
      .flat()
      .flatMap((routine) => (routine.nextRunAt !== null && routine.nextRunAt <= until ? [routine.nextRunAt] : []))
    const next = Math.min(...due, until)
    // A fire moves its routine's next run past now; one that didn't would have the loop stand still.
    if (next < until && next <= server.clock.now()) throw new Error(`A routine due at ${new Date(next).toISOString()} didn't fire`)
    await server.clock.advanceTo(next)
    await server.routines.idle()
    await untilQuiet(server, groupChatIds, deadline)
    if (next >= until) return
  }
}

/** The owner deletes every fact `pattern` matches, in shared memory and every bot's, as in the Memory pane and Settings. */
async function forget(server: TestServer, bots: Map<string, BotInfo>, pattern: RegExp) {
  for (const fact of await server.client.sharedMemory.list()) if (pattern.test(fact.content)) await server.client.sharedMemory.delete({ factId: fact.id })
  for (const bot of bots.values())
    for (const fact of await server.client.bots.memory({ botId: bot.id }))
      if (pattern.test(fact.content)) await server.client.bots.deleteFact({ botId: bot.id, factId: fact.id })
}

/** Polls this often while waiting for the bots. */
const pollMs = 50
/** All is quiet once no bot worked and no group played rounds for this many polls in a row (half a second). */
const quietPolls = 10

/**
 * Waits until no bot is working and no group chat is playing rounds, for a few polls in a row (a bot's message to
 * another wakes it a moment later), then until memory extraction is done with their runs.
 */
async function untilQuiet(server: TestServer, groupChatIds: string[], deadline: number) {
  await untilNoBotWorks(server, groupChatIds, deadline)
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()))))
  const extracted = await Promise.race([server.extraction.idle().then(() => 'idle' as const), timedOut])
  clearTimeout(timer)
  if (extracted === 'timeout') throw new Error('Timed out waiting for memory extraction to finish')
}

/** Waits until no bot is working and no group chat is playing rounds, for `quietPolls` polls in a row. */
async function untilNoBotWorks(server: TestServer, groupChatIds: string[], deadline: number) {
  let quiet = 0
  while (quiet < quietPolls) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the bots to finish')
    const rounds = Promise.all(groupChatIds.map((chatId) => server.rounds.idle(chatId)))
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), deadline - Date.now())))
    const playing = (await Promise.race([rounds.then(() => 'idle' as const), timedOut])) === 'timeout'
    clearTimeout(timer)
    const working = (await server.client.bots.list()).some((bot) => bot.working)
    quiet = playing || working ? 0 : quiet + 1
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

const toChatMessage = (message: MessageInfo): ChatMessage => ({
  from: message.author === 'owner' ? 'owner' : message.card?.type === 'routine_change' ? 'timeline' : message.botMessage ? 'between_bots' : 'bot',
  author: message.authorName,
  text: message.text,
})

/** Fills `record` with every chat's messages, every bot's tool calls, memory at the end and every bot's routines. */
async function collect(server: TestServer, scenario: Scenario, bots: Map<string, BotInfo>, groups: Map<string, string>, record: RunRecord) {
  for (const [name, bot] of bots) record.chats[name] = (await server.client.chats.messages({ chatId: bot.chatId })).map(toChatMessage)
  for (const group of scenario.groups) {
    const chatId = groups.get(group.name)
    record.chats[group.name] = chatId ? (await server.client.chats.messages({ chatId })).map(toChatMessage) : []
  }
  for (const [name, bot] of bots) record.toolCalls.push(...(await server.runtime.toolCalls(bot.id)).map((call) => ({ bot: name, ...call })))
  const source = (fact: FactInfo) => (fact.source === 'owner' ? 'owner' : (fact.sourceBotName ?? 'a bot'))
  for (const fact of await server.client.sharedMemory.list()) record.memory.push({ in: 'shared', tier: fact.tier, text: fact.content, source: source(fact) })
  for (const [name, bot] of bots)
    for (const fact of await server.client.bots.memory({ botId: bot.id })) record.memory.push({ in: name, tier: fact.tier, text: fact.content, source: source(fact) })
  for (const [name, bot] of bots)
    for (const routine of await server.client.routines.list({ botId: bot.id })) {
      const runs = await server.client.routines.runs({ botId: bot.id, routineId: routine.id })
      record.routines.push({
        bot: name,
        name: routine.name,
        prompt: routine.prompt,
        schedule: routine.schedule,
        enabled: routine.enabled,
        by: routine.createdBy,
        runs: runs.map((run) => ({ status: run.status, messaged: run.message !== null })).reverse(),
      })
    }
}

/**
 * Why the run failed outside the bots' behaviour: a bot's model failed it, the memory model failed an extraction, or
 * the faux script didn't fit.
 */
async function runFailures(server: TestServer, bots: Map<string, BotInfo>, models: EvalModels): Promise<string | undefined> {
  const failed = (await server.client.bots.list()).filter((bot) => bot.error)
  if (failed.length) return failed.map((bot) => `${bot.name}'s run failed: ${bot.error}`).join('; ')
  if (server.extraction.skipped.length) return server.extraction.skipped.join('; ')
  if (models.kind === 'real') return
  const left = server.providers.pendingTurns
  if (left) return `The faux script has ${left} turn${left === 1 ? '' : 's'} left over: it no longer fits the scenario`
  const answers = server.providers.memoryModel.pendingTurns
  if (answers) return `The faux memory model has ${answers} answer${answers === 1 ? '' : 's'} left over: it no longer fits the scenario`
}

/** Scores the run on the scenario's rubric; a judge that can't be reached fails every item. */
async function judge(server: TestServer, scenario: Scenario, record: RunRecord, judgeModel: string): Promise<RubricResult[]> {
  try {
    const answer = await server.complete(judgeModel, judgeRequest({ description: scenario.description, rubric: scenario.rubric, record }))
    return parseVerdicts(answer, scenario.rubric)
  } catch (error) {
    return scenario.rubric.map((item) => ({ item, passed: false, reason: `The judge failed: ${(error as Error).message}` }))
  }
}
