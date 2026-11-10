import type { FactTier } from '@openbot/api-contract'

/** Memory's tiers as both apps list facts: what each is called, and what it means. */
export const factTierSections: readonly { tier: FactTier; title: string; hint: string }[] = [
  { tier: 'profile', title: 'Profile', hint: 'Always relevant; never fades.' },
  { tier: 'log', title: 'Log', hint: 'Dated events; they fade but are kept.' },
  { tier: 'note', title: 'Notes', hint: 'Short-lived; out of prompts after a week.' },
]

/** The importances a fact can have, least first; a new fact gets 3. */
export const factImportances = [1, 2, 3, 4, 5] as const

/** Where a fact came from, e.g. "Learned 3 Nov 2026 from you" or "… via Rex". */
export function factOrigin(fact: { createdAt: number; source: string; sourceBotName?: string | null }): string {
  const day = new Date(fact.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  return `Learned ${day} ${fact.source === 'owner' ? 'from you' : `via ${fact.sourceBotName ?? 'a deleted bot'}`}`
}
