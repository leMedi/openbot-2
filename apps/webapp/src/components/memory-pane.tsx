import type { BotInfo, FactInfo, FactTier } from '@openbot/api-contract'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'

const tierSections: { tier: FactTier; title: string; hint: string }[] = [
  { tier: 'profile', title: 'Profile', hint: 'Always relevant; never fades.' },
  { tier: 'log', title: 'Log', hint: 'Dated events; they fade but are kept.' },
  { tier: 'note', title: 'Notes', hint: 'Short-lived; out of its prompt after a week.' },
]

/**
 * A bot's bot memory, read-only for now: its facts by tier, each with its source, importance and the day it was learned. It
 * lists every fact, also those its prompt leaves out. Read again whenever the bot finishes working, which may have
 * changed it.
 */
export function MemoryPane({ bot }: { bot: BotInfo }) {
  const [facts, setFacts] = useState<{ botId: string; facts: FactInfo[] }>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (bot.working) return
    let current = true
    api()
      .bots.memory({ botId: bot.id })
      .then((loaded) => {
        if (!current) return
        setFacts({ botId: bot.id, facts: loaded })
        setError(undefined)
      })
      .catch((caught) => current && setError(errorMessage(caught)))
    return () => {
      current = false
    }
  }, [bot.id, bot.working])
  const shown = facts?.botId === bot.id ? facts.facts : undefined

  return (
    <aside aria-label={`${bot.name}'s memory`} className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle p-5">
      <h2 className="text-lg font-semibold">Memory</h2>
      {error && <p className="text-sm text-destructive-foreground">Couldn't load {bot.name}'s memory: {error}</p>}
      {shown && !shown.length && <p className="text-sm text-muted-foreground">{bot.name} doesn't remember anything yet.</p>}
      {shown &&
        tierSections.map(({ tier, title, hint }) => {
          const inTier = shown.filter((fact) => fact.tier === tier)
          if (!inTier.length) return null
          return (
            <section key={tier} aria-label={title} className="flex flex-col gap-2">
              <header>
                <h3 className="font-medium">{title}</h3>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </header>
              <ul className="flex flex-col gap-2">
                {inTier.map((fact) => (
                  <li key={fact.id} className="rounded-md bg-secondary px-3 py-2">
                    <p className="text-base break-words whitespace-pre-wrap">{fact.content}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Learned {new Date(fact.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}{' '}
                      {fact.source === 'owner' ? 'from you' : `by ${fact.sourceBotName ?? 'a deleted bot'}`} · importance {fact.importance}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
    </aside>
  )
}
