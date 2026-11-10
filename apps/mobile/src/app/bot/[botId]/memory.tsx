import type { FactInfo } from '@openbot/api-contract'
import { factOrigin, factTierSections, useLive } from '@openbot/client'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useCallback } from 'react'
import { Alert } from 'react-native'
import { Group, GroupedScroll, Loading, Note, Row } from '../../../components/grouped.tsx'
import { SwipeRow } from '../../../components/swipe-row.tsx'
import { useBotFacts } from '../../../lib/bot-facts.ts'
import { errorMessage } from '../../../lib/errors.ts'
import { useLoadOnFocus } from '../../../lib/use-load.ts'
import { useWhenDone } from '../../../lib/when-done.ts'

/**
 * A bot's Memory, as the web's pane: every fact of its own memory by tier, also those its prompt leaves out, each with
 * its importance and where it came from. A fact opens to be edited; swiping one left forgets it; Add adds one to its
 * tier. Read again whenever the bot finishes working, which may have changed it.
 */
export default function Memory() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const live = useLive()
  const bot = live.bots?.find((each) => each.id === botId)
  const scope = useBotFacts(botId, bot?.name ?? 'The bot')
  const facts = useLoadOnFocus(useCallback(() => scope.list(), [scope]))
  const { reload } = facts
  useWhenDone(bot?.working, reload)

  const open = (params: { factId: string } | { tier: string }) => router.push({ pathname: '/bot/[botId]/fact', params: { botId, ...params } })
  const forget = (fact: FactInfo) => {
    facts.setData((facts.data ?? []).filter((each) => each.id !== fact.id))
    scope.remove(fact.id).catch((caught) => {
      Alert.alert("Couldn't forget it", errorMessage(caught))
      reload()
    })
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Memory' }} />
      <GroupedScroll>
        {facts.error && !facts.data && <Note tone="error">{`Couldn't load the memory: ${facts.error}`}</Note>}
        {!facts.data && !facts.error && <Loading />}
        {facts.data && (
          <Note>
            {facts.data.length
              ? `What ${bot?.name ?? 'the bot'} remembers. Swipe a fact left to forget it. Changes apply from its next run.`
              : `${bot?.name ?? 'The bot'} doesn't remember anything yet.`}
          </Note>
        )}
        {facts.data &&
          factTierSections.map(({ tier, title, hint }) => (
            <Group key={tier} label={title} note={hint}>
              {facts.data
                ?.filter((fact) => fact.tier === tier)
                .map((fact) => (
                  <SwipeRow key={fact.id} label="Forget" onAction={() => forget(fact)}>
                    <Row label={fact.content} detail={`Importance ${fact.importance} · ${factOrigin(fact)}`} onPress={() => open({ factId: String(fact.id) })} />
                  </SwipeRow>
                ))}
              <Row label={`Add to ${title}`} tone="link" onPress={() => open({ tier })} />
            </Group>
          ))}
      </GroupedScroll>
    </>
  )
}
