import type { ModelProvider } from '@openbot/agent'
import { answeringProvider, callsTools, endsSilently, type FakeTurn, recordingTool, says } from '@openbot/agent/testing'
import type { BotInfo, MessageInfo } from '@openbot/api-contract'
import type { ComputerBot, ExecResult } from '@openbot/core'
import { createTestServer, type TestServer } from '@openbot/webapp/testing'
import { type AssertionResult, checkAssertion } from './assertions.ts'
import { judgeRequest, parseVerdicts, type RubricResult } from './judge.ts'
import type { RunResult } from './report.ts'
import type { FauxTurn, Scenario } from './scenario.ts'
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

const toFakeTurn = (turn: FauxTurn): FakeTurn =>
  'tools' in turn ? callsTools(...(turn.tools as Parameters<typeof callsTools>)) : 'say' in turn ? says(turn.say) : endsSilently()

const providerOf = (ref: string) => ref.slice(0, ref.indexOf('/'))

/** What `date` prints for the clock. */
const dateOutput = (clock: string) => `${new Date(clock).toUTCString()}\n`

/** Runs one scenario on a fresh server: sets it up, sends the owner's messages, then checks and judges what happened. */
export async function runScenario(scenario: Scenario, models: EvalModels, { run = 1, stepTimeoutMs = 300_000 }: RunOptions = {}): Promise<ScenarioRun> {
  const shellLog: ScenarioRun['world']['shell'] = []
  const shell = (command: string, bot: ComputerBot): ExecResult | undefined => {
    const rule = scenario.world.shell.find((candidate) => new RegExp(candidate.match).test(command))
    const result = rule
      ? { stdout: rule.stdout, stderr: rule.stderr, exitCode: rule.exitCode }
      : scenario.world.clock && /^\s*date\b/.test(command)
        ? { stdout: dateOutput(scenario.world.clock), stderr: '', exitCode: 0 }
        : undefined
    shellLog.push({ bot: bot.name, command, stdout: result?.stdout ?? '' })
    return result
  }
  const server = await createTestServer({
    shell,
    pages: scenario.world.pages,
    tools: scenario.world.tools.map((tool) => recordingTool(tool.name, 'mcp', tool).tool),
    modelProviders: models.kind === 'faux' ? [fauxJudgeProvider()] : models.providers,
  })
  const record: RunRecord = { toolCalls: [], chats: {} }
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
    const groups = new Map<string, string>()
    let error: string | undefined
    try {
      for (const step of scenario.script) {
        const deadline = Date.now() + stepTimeoutMs
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
    error ??= await runFailures(server, models)
    const assertions = scenario.assertions.map((assertion) => checkAssertion(assertion, record))
    const rubric = scenario.rubric.length ? await judge(server, scenario, record, models.kind === 'faux' ? fauxJudge : models.judge) : []
    return result({ assertions, rubric, error })
  } catch (caught) {
    return result({ error: (caught as Error).message })
  } finally {
    await server.close()
  }
}

/** Connects the providers, picks the models, scripts the faux turns and creates the bots; returns them by name. */
async function setUp(server: TestServer, scenario: Scenario, models: EvalModels): Promise<Map<string, BotInfo>> {
  if (models.kind === 'faux') {
    await server.connectProvider()
    for (const [bot, turns] of Object.entries(scenario.faux)) server.providers.scriptFor(bot, ...turns.map(toFakeTurn))
  } else {
    const refs = [models.model, models.judge, ...scenario.bots.flatMap((bot) => (bot.model ? [bot.model] : []))]
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
      // On the faux model every bot plays its script.
      model: models.kind === 'faux' ? null : bot.model,
    })
    bots.set(bot.name, created)
  }
  return bots
}

/** Polls this often while waiting for the bots. */
const pollMs = 50
/** All is quiet once no bot worked and no group played rounds for this many polls in a row (half a second). */
const quietPolls = 10

/**
 * Waits until no bot is working and no group chat is playing rounds, for a few polls in a row: a bot's message to
 * another wakes it a moment later.
 */
async function untilQuiet(server: TestServer, groupChatIds: string[], deadline: number) {
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
  from: message.author === 'owner' ? 'owner' : message.botMessage ? 'between_bots' : 'bot',
  author: message.authorName,
  text: message.text,
})

/** Fills `record` with every chat's messages and every bot's tool calls. */
async function collect(server: TestServer, scenario: Scenario, bots: Map<string, BotInfo>, groups: Map<string, string>, record: RunRecord) {
  for (const [name, bot] of bots) record.chats[name] = (await server.client.chats.messages({ chatId: bot.chatId })).map(toChatMessage)
  for (const group of scenario.groups) {
    const chatId = groups.get(group.name)
    record.chats[group.name] = chatId ? (await server.client.chats.messages({ chatId })).map(toChatMessage) : []
  }
  for (const [name, bot] of bots) record.toolCalls.push(...(await server.runtime.toolCalls(bot.id)).map((call) => ({ bot: name, ...call })))
}

/** Why the run failed outside the bots' behaviour: a bot's model failed it, or the faux script didn't fit. */
async function runFailures(server: TestServer, models: EvalModels): Promise<string | undefined> {
  const failed = (await server.client.bots.list()).filter((bot) => bot.error)
  if (failed.length) return failed.map((bot) => `${bot.name}'s run failed: ${bot.error}`).join('; ')
  const left = models.kind === 'faux' ? server.providers.pendingTurns : 0
  if (left) return `The faux script has ${left} turn${left === 1 ? '' : 's'} left over: it no longer fits the scenario`
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
