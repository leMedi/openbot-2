import { factTiers } from '@openbot/api-contract'
import { useLocalSearchParams } from 'expo-router'
import { useMemo } from 'react'
import { EditFact, type FactScope, NewFact } from '../../components/fact-editor.tsx'
import { useInstance } from '../../lib/instance-context.ts'

/** A shared fact (`factId`) to edit, or with `tier` instead, a new shared fact for that tier. */
export default function Fact() {
  const params = useLocalSearchParams<{ factId?: string; tier?: string }>()
  const { api } = useInstance()
  const scope = useMemo<FactScope>(
    () => ({
      list: () => api.sharedMemory.list(),
      add: (fact) => api.sharedMemory.add(fact),
      edit: (factId, changes) => api.sharedMemory.edit({ factId, ...changes }),
      remove: (factId) => api.sharedMemory.delete({ factId }),
      who: 'Every bot',
    }),
    [api],
  )
  if (params.factId) return <EditFact factId={Number(params.factId)} scope={scope} />
  return <NewFact tier={factTiers.find((each) => each === params.tier) ?? 'profile'} scope={scope} />
}
