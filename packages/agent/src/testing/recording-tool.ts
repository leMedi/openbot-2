import { type JsonObject, Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { Surface } from '@openbot/db'
import type { BotTool } from '../runtime.ts'

/** A tool with `surface` that takes any arguments and records the calls that ran, e.g. a stand-in shell tool. */
export function recordingTool(name: string, surface: Surface | null) {
  const calls: JsonObject[] = []
  const tool: BotTool = {
    surface,
    tool: defineTool({
      name,
      description: `Test tool ${name}`,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (args) => {
        calls.push(args as JsonObject)
        return { output: [{ type: 'text', text: 'Done.' }] }
      },
    }),
  }
  return { tool, calls }
}
