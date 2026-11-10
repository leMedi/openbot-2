import type { AuditEntryInfo } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { auditSummary } from './audit.ts'

const entry = (changes: Partial<AuditEntryInfo>): AuditEntryInfo => ({
  id: 'a1',
  botId: 'rex',
  kind: 'action',
  surface: 'shell',
  tool: 'bash',
  server: null,
  input: {},
  verdict: null,
  mode: 'off',
  outcome: { status: 'ok', durationMs: 120 },
  createdAt: 0,
  ...changes,
})

describe('an audit entry as Activity lists it', () => {
  it('says what a shell call did, with its command or file', () => {
    expect(auditSummary(entry({ input: { command: 'ls -la' } }))).toEqual({ title: 'Ran a command', detail: 'ls -la', status: 'ok' })
    expect(auditSummary(entry({ tool: 'write', input: { path: '/home/rex/notes.md', content: '…' } }))).toEqual({ title: 'Wrote a file', detail: '/home/rex/notes.md', status: 'ok' })
    expect(auditSummary(entry({ tool: 'edit', input: { path: 'a.ts' }, outcome: { status: 'error', durationMs: 3 } }))).toEqual({ title: 'Edited a file', detail: 'a.ts', status: 'error' })
  })

  it("names a plugin tool's call by its tool and account", () => {
    expect(
      auditSummary(entry({ surface: 'mcp', tool: 'mcp__clickup_account1__clickup_search', server: 'clickup_account1', input: { keywords: 'x' } })),
    ).toEqual({ title: 'clickup_search', detail: 'clickup_account1', status: 'ok' })
  })

  it("puts the orchestrator's deny or ask first, with its reason", () => {
    expect(auditSummary(entry({ input: { command: 'rm -rf /' }, verdict: { decision: 'deny', reason: 'Destructive' }, outcome: null }))).toEqual({
      title: 'Ran a command',
      detail: 'rm -rf / · Denied: Destructive',
      status: 'denied',
    })
    expect(auditSummary(entry({ input: { command: 'curl x' }, verdict: { decision: 'ask', reason: 'Network' }, outcome: null })).status).toBe('asked')
  })

  it("says which page a computer session opened, how a session ended, and why a routine's run failed", () => {
    expect(auditSummary(entry({ kind: 'navigation', surface: 'computer_session', tool: 'browser_navigate', input: { url: 'https://a.com/x', title: 'A page' }, outcome: null }))).toEqual({
      title: 'Opened a page',
      detail: 'A page · https://a.com/x',
      status: undefined,
    })
    expect(
      auditSummary(
        entry({ kind: 'session_summary', surface: 'computer_session', tool: 'use_computer', input: { outcome: 'needs_help', actions: { browser_click: 3 }, screenshots: 2, durationMs: 95_000 }, outcome: null }),
      ),
    ).toEqual({ title: 'Computer session ended', detail: 'Asked you to take over · 3 actions · 1 min 35 s', status: undefined })
    expect(
      auditSummary(entry({ kind: 'routine', surface: 'routine_change', tool: 'routine', input: { name: 'Digest', status: 'failed', error: 'No model' }, outcome: null })),
    ).toEqual({ title: 'Routine “Digest” failed', detail: 'No model', status: 'error' })
  })

  it('says what a routine or shared-memory change did', () => {
    expect(auditSummary(entry({ surface: 'routine_change', tool: 'update_state', input: { target: 'routine', action: 'create', name: 'Digest' } }))).toEqual({
      title: 'Created a routine',
      detail: 'Digest',
      status: 'ok',
    })
    expect(auditSummary(entry({ surface: 'memory_shared_write', tool: 'update_state', input: { target: 'memory', action: 'write', scope: 'shared', text: 'Likes tea' } }))).toEqual({
      title: 'Wrote to shared memory',
      detail: 'Likes tea',
      status: 'ok',
    })
  })
})
