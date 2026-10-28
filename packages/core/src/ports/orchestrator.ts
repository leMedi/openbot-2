import type { Surface, Verdict } from '@openbot/db'

export type { OrchestratorMode, Surface, Verdict } from '@openbot/db'

/**
 * A side-effecting action a bot is about to take, with secrets already redacted; `server` is the MCP server a plugin
 * tool calls, `<plugin>_<accountN>`.
 */
export type ProposedAction = { surface: Surface; tool: string; input: unknown; server?: string }

export type ReviewContext = { botId: string }

/** Judges a bot's side-effecting actions before they happen. Messages between bots are never reviewed. */
export interface Orchestrator {
  review(action: ProposedAction, ctx: ReviewContext): Promise<Verdict>
}
