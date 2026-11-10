import { factOrigin, factTierSections } from '@openbot/client'
import { router, Stack } from 'expo-router'
import { useCallback } from 'react'
import { Group, GroupedScroll, Loading, Note, Row } from '../../components/grouped.tsx'
import { useInstance } from '../../lib/instance-context.ts'
import { useLoadOnFocus } from '../../lib/use-load.ts'

/**
 * Settings → Shared memory, as the web's: the facts every bot knows, by tier, each with its importance and where it
 * came from. A fact opens to be edited or deleted; Add adds one to its tier. Bots see the change on their next run.
 */
export default function SharedMemory() {
  const { api } = useInstance()
  const facts = useLoadOnFocus(useCallback(() => api.sharedMemory.list(), [api]))

  return (
    <>
      <Stack.Screen options={{ title: 'Shared memory' }} />
      <GroupedScroll>
        <Note>
          {"What every bot knows, mostly about you. A bot's own memory and its instructions win over it. Bots' changes to it are reviewed by the orchestrator; yours reach every bot on its next run."}
        </Note>
        {facts.error && !facts.data && <Note tone="error">{`Couldn't load shared memory: ${facts.error}`}</Note>}
        {!facts.data && !facts.error && <Loading />}
        {facts.data &&
          factTierSections.map(({ tier, title, hint }) => (
            <Group key={tier} label={title} note={hint}>
              {facts.data
                ?.filter((fact) => fact.tier === tier)
                .map((fact) => (
                  <Row
                    key={fact.id}
                    label={fact.content}
                    detail={`Importance ${fact.importance} · ${factOrigin(fact)}`}
                    onPress={() => router.push({ pathname: '/settings/fact', params: { factId: String(fact.id) } })}
                  />
                ))}
              <Row label={`Add to ${title}`} tone="link" onPress={() => router.push({ pathname: '/settings/fact', params: { tier } })} />
            </Group>
          ))}
      </GroupedScroll>
    </>
  )
}
