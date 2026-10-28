import type { FactInfo } from '@openbot/api-contract'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { FactsByTier } from '../../components/memory-pane.tsx'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/shared-memory')({
  component: SharedMemory,
})

/**
 * Settings → Shared memory: the facts every bot knows, mostly about the owner, by tier with their source and date;
 * read-only for now. It lists every fact, also those prompts leave out.
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
          orchestrator.
        </p>
      </header>

      {error && <p className="text-destructive-foreground">Couldn't load shared memory: {error}</p>}
      {facts && !facts.length && <p className="text-muted-foreground">Your bots don't share any memory yet.</p>}
      {facts && <FactsByTier facts={facts} />}
    </section>
  )
}
