import type { RoutineInfo } from '@openbot/api-contract'
import { describeSchedule, useLive } from '@openbot/client'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useInstance } from '../../lib/instance-context.ts'
import { radii, useColors } from '../../lib/theme.ts'

/**
 * A routine, opened from a search hit: a first cut, read-only, that the bot info screen's work replaces with the
 * routine editor. It shows the routine's bot, schedule and instruction.
 */
export default function Routine() {
  const { routineId, botId } = useLocalSearchParams<{ routineId: string; botId: string }>()
  const live = useLive()
  const { api } = useInstance()
  const colors = useColors()
  const [routine, setRoutine] = useState<RoutineInfo | null>()
  const bot = live.bots?.find((entry) => entry.id === botId)

  useEffect(() => {
    let current = true
    api.routines
      .list({ botId })
      .then((routines) => current && setRoutine(routines.find((entry) => entry.id === routineId) ?? null))
      .catch(() => current && setRoutine(null))
    return () => {
      current = false
    }
  }, [api, botId, routineId])

  const rows: [string, string][] = routine
    ? [
        ['Bot', bot?.name ?? ''],
        ['Schedule', routine.enabled ? (describeSchedule(routine.schedule) ?? routine.schedule) : 'Paused'],
      ]
    : []

  return (
    <>
      <Stack.Screen options={{ title: routine?.name ?? 'Routine', headerBackTitle: 'Chats', headerLargeTitle: false }} />
      {routine === undefined ? (
        <ActivityIndicator style={styles.loading} color={colors.mutedForeground} />
      ) : routine === null ? (
        <Text style={[styles.missing, { color: colors.mutedForeground }]}>This routine is gone.</Text>
      ) : (
        <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
          <View style={[styles.list, { backgroundColor: colors.muted }]}>
            {rows.map(([label, value], index) => (
              <View key={label} style={[styles.item, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
                <Text numberOfLines={1} style={[styles.value, { color: colors.mutedForeground }]}>
                  {value}
                </Text>
              </View>
            ))}
          </View>
          <Text style={[styles.groupLabel, { color: colors.mutedForeground }]}>INSTRUCTION</Text>
          <View style={[styles.list, styles.instruction, { backgroundColor: colors.muted }]}>
            <Text style={[styles.label, { color: colors.foreground }]}>{routine.prompt}</Text>
          </View>
        </ScrollView>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  missing: { textAlign: 'center', marginTop: 48, fontSize: 15 },
  content: { padding: 16, gap: 8 },
  list: { borderRadius: radii.xl, overflow: 'hidden' },
  item: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingHorizontal: 12, minHeight: 44 },
  label: { fontSize: 15 },
  value: { fontSize: 15, flexShrink: 1 },
  groupLabel: { fontSize: 12, letterSpacing: 0.6, paddingHorizontal: 12, paddingTop: 14 },
  instruction: { padding: 12 },
})
