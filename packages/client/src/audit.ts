import type { AuditEntryInfo } from '@openbot/api-contract'

/** How an entry ended, as its row marks it: the orchestrator's deny or ask, or how the action ran; none for the rest. */
export type AuditStatus = 'ok' | 'error' | 'denied' | 'asked' | undefined

export type AuditSummary = { title: string; detail?: string; status: AuditStatus }

const sessionOutcomes: Record<string, string> = { done: 'Answered', needs_help: 'Asked you to take over', stopped: 'Stopped without an answer' }

/** A duration in words, e.g. "1 min 35 s" or "4 s". */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ''}` : `${seconds} s`
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** The verb of a change `update_state` made, e.g. "Created". */
const changeVerbs: Record<string, string> = { create: 'Created', update: 'Changed', edit: 'Changed', delete: 'Deleted', pause: 'Paused', resume: 'Resumed', write: 'Wrote', forget: 'Forgot' }

/** What an action did and to what, from its surface, tool and input. */
function describeAction(entry: AuditEntryInfo, input: Record<string, unknown>): { title: string; detail?: string } {
  switch (entry.surface) {
    case 'shell':
      if (entry.tool === 'write') return { title: 'Wrote a file', detail: text(input.path) }
      if (entry.tool === 'edit') return { title: 'Edited a file', detail: text(input.path) }
      return { title: 'Ran a command', detail: text(input.command) }
    case 'mcp':
      // mcp__<server>__<tool>
      return { title: entry.tool.replace(/^mcp__.+?__/, ''), detail: entry.server ?? undefined }
    case 'computer_session':
      return { title: 'Used its computer', detail: text(input.goal) }
    case 'plugin_request':
      return { title: 'Asked for a plugin', detail: text(input.name) ?? text(input.plugin) }
    case 'routine_change':
      return { title: `${changeVerbs[String(input.action)] ?? 'Changed'} a routine`, detail: text(input.name) ?? text(input.prompt) }
    case 'memory_shared_write':
      return { title: input.action === 'write' ? 'Wrote to shared memory' : `${changeVerbs[String(input.action)] ?? 'Changed'} a shared fact`, detail: text(input.text) }
    default:
      return { title: entry.tool }
  }
}

/**
 * An audit entry as a bot's Activity lists it: what the bot did in a few words, what it did it to (a command, a file, a
 * page, a plugin account), the orchestrator's reason when it denied or asked, and how it ended.
 */
export function auditSummary(entry: AuditEntryInfo): AuditSummary {
  const input = (entry.input && typeof entry.input === 'object' ? entry.input : {}) as Record<string, unknown>
  if (entry.kind === 'navigation') {
    return { title: 'Opened a page', detail: [text(input.title), text(input.url)].filter(Boolean).join(' · ') || undefined, status: undefined }
  }
  if (entry.kind === 'session_summary') {
    const actions = Object.values((input.actions ?? {}) as Record<string, number>).reduce((sum, count) => sum + count, 0)
    const parts = [sessionOutcomes[String(input.outcome)], `${actions} ${actions === 1 ? 'action' : 'actions'}`, typeof input.durationMs === 'number' ? duration(input.durationMs) : undefined]
    return { title: 'Computer session ended', detail: parts.filter(Boolean).join(' · '), status: undefined }
  }
  if (entry.kind === 'routine') {
    return { title: `Routine “${text(input.name) ?? 'a routine'}” failed`, detail: text(input.error), status: 'error' }
  }
  const { title, detail } = describeAction(entry, input)
  const verdict = entry.verdict
  if (verdict && verdict.decision !== 'allow') {
    const reason = `${verdict.decision === 'deny' ? 'Denied' : 'Asked first'}: ${verdict.reason}`
    return { title, detail: [detail, reason].filter(Boolean).join(' · '), status: verdict.decision === 'deny' ? 'denied' : 'asked' }
  }
  return { title, detail, status: entry.outcome?.status }
}
