import type { Context } from '@earendil-works/chord'
import { type ExecutionError, ok, type Result, type ShellExecOptions, type ShellExecResult } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { Computer, ComputerBot } from '@openbot/core'
import { BotComputer } from '../computer.ts'

/** Files on this machine; commands go to `computer.shell`, which a fake computer records and answers from its script. */
class FakeShellEnv extends NodeExecutionEnv {
  readonly #computer: Computer
  readonly #bot: ComputerBot

  constructor(computer: Computer, bot: ComputerBot, cwd: string) {
    super({ cwd })
    this.#computer = computer
    this.#bot = bot
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const result = await this.#computer.shell.exec(this.#bot, typeof command === 'string' ? command : command.join(' '))
    if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: 'stdout' })
    if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: 'stderr' })
    return ok({ exitCode: result.exitCode })
  }
}

/**
 * Bots' computer for Seam 1: files live under `home` on this machine, and shell commands go to `computer` (the in-memory
 * fake from `@openbot/core/testing`), so tests script their results and see every command.
 */
export function fakeBotComputer(computer: Computer, home: string): BotComputer {
  return new BotComputer({ home, user: 'openbot', env: (bot, cwd) => new FakeShellEnv(computer, bot, cwd) })
}
