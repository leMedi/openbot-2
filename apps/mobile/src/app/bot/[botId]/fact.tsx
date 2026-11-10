import { factTiers } from '@openbot/api-contract'
import { useLive } from '@openbot/client'
import { useLocalSearchParams } from 'expo-router'
import { EditFact, NewFact } from '../../../components/fact-editor.tsx'
import { useBotFacts } from '../../../lib/bot-facts.ts'

/** A fact of a bot's memory (`factId`) to edit, or with `tier` instead, a new one for that tier. */
export default function BotFact() {
  const params = useLocalSearchParams<{ botId: string; factId?: string; tier?: string }>()
  const live = useLive()
  const name = live.bots?.find((each) => each.id === params.botId)?.name ?? 'The bot'
  const scope = useBotFacts(params.botId, name)
  if (params.factId) return <EditFact factId={Number(params.factId)} scope={scope} />
  return <NewFact tier={factTiers.find((each) => each === params.tier) ?? 'profile'} scope={scope} />
}
