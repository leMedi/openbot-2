import type { Context } from '@earendil-works/chord'
import { type ExecutionError, ok, type Result, type ShellExecOptions, type ShellExecResult } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ComputerBot } from '@openbot/core'
import { BotComputer } from '../computer.ts'

/** What a command printed, and how it exited. */
export type ExecResult = { stdout: string; stderr: string; exitCode: number }

/** Result for a bot's command; `undefined` falls back to an empty success. */
export type FakeShellScript = (command: string, bot: ComputerBot) => ExecResult | undefined

/** A command a bot ran, keyed by bot name. */
export type FakeCommand = { bot: string; command: string }

/** Files on this machine; commands are recorded and answered from the script instead of run. */
class FakeShellEnv extends NodeExecutionEnv {
  readonly #run: (command: string) => ExecResult

  constructor(cwd: string, run: (command: string) => ExecResult) {
    super({ cwd })
    this.#run = run
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const result = this.#run(typeof command === 'string' ? command : command.join(' '))
    if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: 'stdout' })
    if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: 'stderr' })
    return ok({ exitCode: result.exitCode })
  }
}

export type FakeBotComputer = BotComputer & {
  /** Every command bots ran, in order. */
  readonly commands: FakeCommand[]
}

/**
 * Bots' computer for Seam 1: files live under `home` on this machine, and shell commands are answered from `script`
 * and recorded instead of run, so tests script their results and see every command.
 */
export function fakeBotComputer(home: string, script?: FakeShellScript): FakeBotComputer {
  const commands: FakeCommand[] = []
  const run = (bot: ComputerBot, command: string) => {
    commands.push({ bot: bot.name, command })
    return script?.(command, bot) ?? { stdout: '', stderr: '', exitCode: 0 }
  }
  const computer = new BotComputer({ home, user: 'openbot', env: (bot, cwd) => new FakeShellEnv(cwd, (command) => run(bot, command)) })
  return Object.assign(computer, { commands })
}
