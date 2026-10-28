import type { FactInfo } from '@openbot/api-contract'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { type FactActions, FactsByTier } from '../../components/memory-pane.tsx'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/shared-memory')({
  component: SharedMemory,
})

/** How the owner changes shared memory. */
const sharedActions: FactActions = {
  add: (fact) => api().sharedMemory.add(fact),
  edit: (factId, changes) => api().sharedMemory.edit({ factId, ...changes }),
  remove: (factId) => api().sharedMemory.delete({ factId }),
}

/**
 * Settings → Shared memory: the facts every bot knows, mostly about the owner, by tier with their source and date,
 * which the owner adds, edits and deletes; every bot sees the change on its next run. It lists every fact, also those
 * prompts leave out.
 */
function SharedMemory() {
  const [facts, setFacts] = useState<FactInfo[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api().sharedMemory.list().then(setFacts, (caught) => setError(errorMessage(caught)))
  }, [])

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-xl font-semibold">Shared memory</h2>
        <p className="text-sm text-muted-foreground">
          What every bot knows, mostly about you. A bot's bot memory and its instructions win over it. Bots' changes to it are reviewed by the
          orchestrator; yours reach every bot on its next run.
        </p>
      </header>

      {error && <p className="text-destructive-foreground">Couldn't load shared memory: {error}</p>}
      {facts && !facts.length && <p className="text-muted-foreground">Your bots don't share any memory yet.</p>}
      {facts && <FactsByTier facts={facts} actions={sharedActions} onChange={(change) => setFacts((current) => current && change(current))} />}
    </section>
  )
}
