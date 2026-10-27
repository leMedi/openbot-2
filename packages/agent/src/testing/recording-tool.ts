import { type JsonObject, Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { Surface } from '@openbot/db'
import type { BotTool } from '../runtime.ts'

/**
 * A tool with `surface` that takes any arguments, records the calls that ran and answers `result`, e.g. a stand-in
 * shell tool, or a fake tool server's tool in evals.
 */
export function recordingTool(name: string, surface: Surface | null, { description = `Test tool ${name}`, result = 'Done.' } = {}) {
  const calls: JsonObject[] = []
  const tool: BotTool = {
    surface,
    tool: defineTool({
      name,
      description,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (args) => {
        calls.push(args as JsonObject)
        return { output: [{ type: 'text', text: result }] }
      },
    }),
  }
  return { tool, calls }
}
