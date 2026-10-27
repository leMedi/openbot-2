import { type AuditEntry, type AuditKind, auditLog, bots, type Db, type OrchestratorMode, settings, type Surface, surfaces, type Verdict } from '@openbot/db'
import { asc, eq } from 'drizzle-orm'
import type { Orchestrator, ProposedAction } from './ports/orchestrator.ts'

/** A mode for every surface. */
export type OrchestratorModes = Record<Surface, OrchestratorMode>

/** Modes set for some surfaces only, e.g. a bot's overrides. */
export type ModeOverrides = Partial<OrchestratorModes>

/** A surface no one set a mode for is reviewed in shadow: judged and logged, never blocked. */
export const defaultOrchestratorMode: OrchestratorMode = 'shadow'

const modesKey = 'orchestratorModes'

/** P0's orchestrator: allows everything, so the audit log still records every proposed action. */
export class AllowAllOrchestrator implements Orchestrator {
  async review(): Promise<Verdict> {
    return { decision: 'allow' }
  }
}

function withDefaults(overrides: ModeOverrides): OrchestratorModes {
  return Object.fromEntries(surfaces.map((surface) => [surface, overrides[surface] ?? defaultOrchestratorMode])) as OrchestratorModes
}

async function readGlobalOverrides(db: Pick<Db, 'select'>): Promise<ModeOverrides> {
  const [row] = await db.select().from(settings).where(eq(settings.key, modesKey))
  return (row?.value as ModeOverrides | undefined) ?? {}
}

/** The global mode of every surface. */
export async function readOrchestratorModes(db: Db): Promise<OrchestratorModes> {
  return withDefaults(await readGlobalOverrides(db))
}

export async function writeOrchestratorModes(db: Db, changes: ModeOverrides): Promise<OrchestratorModes> {
  return db.transaction(async (tx) => {
    const value = { ...(await readGlobalOverrides(tx)), ...changes }
    await tx
      .insert(settings)
      .values({ key: modesKey, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    return withDefaults(value)
  })
}

/** A bot's own overrides, and the modes it is reviewed in: its override where it has one, else the global mode. */
export type BotOrchestratorModes = { overrides: ModeOverrides; modes: OrchestratorModes }

/** Undefined when there is no such bot. */
export async function readBotOrchestratorModes(db: Db, botId: string): Promise<BotOrchestratorModes | undefined> {
  const [bot] = await db.select({ overrides: bots.orchestratorModes }).from(bots).where(eq(bots.id, botId))
  if (!bot) return undefined
  return { overrides: bot.overrides, modes: withDefaults({ ...(await readGlobalOverrides(db)), ...bot.overrides }) }
}

/** Sets a bot's overrides; null clears one, so the surface follows the global mode again. */
export async function writeBotOrchestratorModes(
  db: Db,
  botId: string,
  changes: Partial<Record<Surface, OrchestratorMode | null>>,
): Promise<BotOrchestratorModes | undefined> {
  const found = await db.transaction(async (tx) => {
    const [bot] = await tx.select({ overrides: bots.orchestratorModes }).from(bots).where(eq(bots.id, botId))
    if (!bot) return false
    const overrides: ModeOverrides = { ...bot.overrides }
    for (const surface of surfaces) {
      const mode = changes[surface]
      if (mode === null) delete overrides[surface]
      else if (mode !== undefined) overrides[surface] = mode
    }
    await tx.update(bots).set({ orchestratorModes: overrides }).where(eq(bots.id, botId))
    return true
  })
  return found ? readBotOrchestratorModes(db, botId) : undefined
}

const redacted = '[redacted]'
/** Keys whose values are secrets wherever they appear in a tool call's input. */
const secretKeyName = /password|passphrase|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key/i
/** Secrets inside free text, such as a shell command. */
const secretPatterns: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, redacted],
  [/\b(bearer|basic)\s+[\w.~+/-]+=*/gi, `$1 ${redacted}`],
  [/\b(\w*(?:pass(?:word)?|secret|token|api[-_]?key)\w*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1$2${redacted}`],
  [/\b(sk|pk|rk)-[\w-]{16,}/g, redacted],
  [/\b(ghp|gho|ghu|ghs|github_pat|xox[abpr])_[\w-]{16,}/g, redacted],
]

/** `value` with secrets replaced, so they never reach the orchestrator or the audit log. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return secretPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, secretKeyName.test(key) && entry !== null && typeof entry !== 'object' ? redacted : redactSecrets(entry)]),
    )
  }
  return value
}

async function surfaceMode(db: Db, botId: string, surface: Surface): Promise<OrchestratorMode> {
  return (await readBotOrchestratorModes(db, botId))?.modes[surface] ?? defaultOrchestratorMode
}

/**
 * Reviews a bot's side-effecting tool call (secrets not yet redacted) in the mode of its surface for that bot, and writes it to the audit log,
 * with the verdict, whatever the mode: off means not reviewed, not unrecorded. Returns why the call is blocked, or undefined to let it run. Only
 * enforce mode blocks.
 */
export async function reviewAction(
  db: Db,
  orchestrator: Orchestrator,
  botId: string,
  call: ProposedAction,
): Promise<string | undefined> {
  const mode = await surfaceMode(db, botId, call.surface)
  const action: ProposedAction = { ...call, input: redactSecrets(call.input) }
  const verdict = mode === 'off' ? null : await orchestrator.review(action, { botId })
  await db.insert(auditLog).values({ botId, kind: 'action', surface: action.surface, tool: action.tool, action: action.input, verdict, mode })
  if (mode !== 'enforce' || !verdict || verdict.decision === 'allow') return undefined
  // There are no approval cards yet, so an ask blocks like a deny.
  return `The orchestrator blocked this action: ${verdict.reason}`
}

/**
 * Writes what a bot did that is never reviewed on its own to its audit log, under the surface whose review covered it, e.g. a page a computer-use
 * session's browser opened. Secrets in `input` are redacted.
 */
export async function recordActivity(
  db: Db,
  botId: string,
  entry: { kind: Exclude<AuditKind, 'action'>; surface: Surface; tool: string; input: unknown },
): Promise<void> {
  const mode = await surfaceMode(db, botId, entry.surface)
  await db.insert(auditLog).values({ botId, kind: entry.kind, surface: entry.surface, tool: entry.tool, action: redactSecrets(entry.input), mode })
}

/** A bot's audit log, oldest first. */
export async function listAuditEntries(db: Db, botId: string): Promise<AuditEntry[]> {
  return db.select().from(auditLog).where(eq(auditLog.botId, botId)).orderBy(asc(auditLog.id))
}
