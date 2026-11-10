import type { RoutineInfo } from '@openbot/api-contract'
import { applyRoutineEvent, describeSchedule, sortRoutines, useLive, useLiveEvents } from '@openbot/client'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback } from 'react'
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native'
import { Group, GroupedScroll, Loading, Note, Row } from '../../../components/grouped.tsx'
import { ClockIcon, PauseIcon, PlusIcon } from '../../../components/icons.tsx'
import { useInstance } from '../../../lib/instance-context.ts'
import { openRoutine } from '../../../lib/routes.ts'
import { useColors } from '../../../lib/theme.ts'
import { useLoadOnFocus } from '../../../lib/use-load.ts'

/**
 * A bot's Routines, as the web's pane: its routines, active first, each with its schedule in words or "Paused", live
 * as they change; each opens its editor, and + creates one.
 */
export default function Routines() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const { api } = useInstance()
  const live = useLive()
  const colors = useColors()
  const name = live.bots?.find((each) => each.id === botId)?.name ?? 'the bot'
  const routines = useLoadOnFocus(useCallback(() => api.routines.list({ botId }), [api, botId]))
  const { data, update, reload } = routines
  useLiveEvents((event) => {
    if (event.type === 'hello' && !event.resumed) return reload()
    update((current) => applyRoutineEvent(current, botId, event)!)
  })

  const icon = (routine: RoutineInfo) =>
    routine.running ? (
      <ActivityIndicator accessibilityLabel="Running" color={colors.mutedForeground} />
    ) : routine.enabled ? (
      <ClockIcon size={18} color={colors.mutedForeground} />
    ) : (
      <PauseIcon size={18} color={colors.mutedForeground} />
    )

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Routines',
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="New routine" hitSlop={8} onPress={() => openRoutine(botId, 'new')} style={styles.add}>
              <PlusIcon color={colors.foreground} />
            </Pressable>
          ),
        }}
      />
      <GroupedScroll>
        {routines.error && !data && <Note tone="error">{`Couldn't load ${name}'s routines: ${routines.error}`}</Note>}
        {!data && !routines.error && <Loading />}
        {data && (
          <Group note={`Routines wake ${name} on a schedule to follow an instruction, such as sending you a morning digest.`}>
            {sortRoutines(data).map((routine) => (
              <Row
                key={routine.id}
                icon={icon(routine)}
                label={routine.name}
                detail={routine.enabled ? (describeSchedule(routine.schedule) ?? routine.schedule) : 'Paused'}
                onPress={() => openRoutine(botId, routine.id)}
              />
            ))}
            <Row label="Create Routine" tone="link" onPress={() => openRoutine(botId, 'new')} />
          </Group>
        )}
      </GroupedScroll>
    </>
  )
}

const styles = StyleSheet.create({
  add: { minWidth: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
})
