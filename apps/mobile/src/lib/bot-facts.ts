import { useMemo } from 'react'
import type { FactScope } from '../components/fact-editor.tsx'
import { useInstance } from './instance-context.ts'

/** A bot's own memory, as the fact editor changes it. */
export function useBotFacts(botId: string, botName: string): FactScope {
  const { api } = useInstance()
  return useMemo(
    () => ({
      list: () => api.bots.memory({ botId }),
      add: (fact) => api.bots.addFact({ botId, ...fact }),
      edit: (factId, changes) => api.bots.editFact({ botId, factId, ...changes }),
      remove: (factId) => api.bots.deleteFact({ botId, factId }),
      who: botName,
    }),
    [api, botId, botName],
  )
}
