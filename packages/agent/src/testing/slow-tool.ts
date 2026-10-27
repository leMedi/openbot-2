import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { BotTool } from '../runtime.ts'

/**
 * A tool without side effects whose calls run until interrupted, like a long shell command or computer-use session;
 * with `ignoresInterrupt`, a wedged one, until `finish()`.
 */
export function slowTool(name: string, { ignoresInterrupt = false } = {}) {
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => (markStarted = resolve))
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  let interrupted = false
  const tool: BotTool = {
    surface: null,
    tool: defineTool({
      name,
      description: `Test tool ${name}, which takes a long time`,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (_args, _api, context) => {
        markStarted()
        const aborted = new Promise<void>((resolve) => context.abortSignal?.addEventListener('abort', () => resolve(), { once: true }))
        await Promise.race([finished, ignoresInterrupt ? new Promise<never>(() => {}) : aborted])
        if (context.abortSignal?.aborted) interrupted = true
        return { output: [{ type: 'text', text: 'Done.' }] }
      },
    }),
  }
  return {
    tool,
    /** Resolves once a call has started. */
    started,
    /** Ends every call, interrupted or not. */
    finish,
    /** Whether a call saw its interrupt. */
    get interrupted() {
      return interrupted
    },
  }
}
