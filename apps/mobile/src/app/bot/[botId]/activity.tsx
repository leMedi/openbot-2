import type { AuditEntryInfo } from '@openbot/api-contract'
import { type AuditStatus, auditSummary, relativeTime, useLive, useNow } from '@openbot/client'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { Loading, Note } from '../../../components/grouped.tsx'
import { useInstance } from '../../../lib/instance-context.ts'
import { useColors } from '../../../lib/theme.ts'
import { useLoadOnFocus } from '../../../lib/use-load.ts'

const statusLabels: Record<Exclude<AuditStatus, undefined>, string> = { ok: 'Done', error: 'Failed', denied: 'Denied', asked: 'Asked first' }

/**
 * A bot's Activity: its audit log, newest first (design §5.2): every side-effecting action it took, reviewed or not,
 * and its computer sessions' pages and summaries, with secrets redacted. A row opens to show what it was given. Read
 * only: the web has no Activity pane yet, so there's nothing more to change here (the orchestrator's modes and rules
 * join when it does).
 */
export default function Activity() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const { api } = useInstance()
  const live = useLive()
  const colors = useColors()
  const now = useNow()
  const bot = live.bots?.find((each) => each.id === botId)
  const entries = useLoadOnFocus(useCallback(() => api.bots.audit({ botId }).then((all) => [...all].reverse()), [api, botId]))
  const [open, setOpen] = useState<string>()

  return (
    <>
      <Stack.Screen options={{ title: 'Activity' }} />
      {entries.error && !entries.data ? (
        <View style={styles.top}>
          <Note tone="error">{`Couldn't load the activity: ${entries.error}`}</Note>
        </View>
      ) : !entries.data ? (
        <Loading />
      ) : (
        <FlatList
          data={entries.data}
          keyExtractor={(entry) => entry.id}
          contentInsetAdjustmentBehavior="automatic"
          style={{ backgroundColor: colors.background }}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={[styles.intro, { color: colors.mutedForeground }]}>
              {entries.data.length
                ? `Everything ${bot?.name ?? 'the bot'} did that changed something, newest first, with secrets hidden.`
                : `${bot?.name ?? 'The bot'} hasn't done anything that changed something yet.`}
            </Text>
          }
          renderItem={({ item, index }) => (
            <Entry entry={item} first={index === 0} last={index === entries.data!.length - 1} now={now} open={open === item.id} onToggle={() => setOpen((current) => (current === item.id ? undefined : item.id))} />
          )}
        />
      )}
    </>
  )
}

function Entry({ entry, first, last, now, open, onToggle }: { entry: AuditEntryInfo; first: boolean; last: boolean; now: number; open: boolean; onToggle: () => void }) {
  const colors = useColors()
  const summary = auditSummary(entry)
  const tone =
    summary.status === 'error' || summary.status === 'denied' ? colors.destructiveForeground : summary.status === 'asked' ? colors.amberForeground : colors.mutedForeground
  const meta = [summary.status && statusLabels[summary.status], entry.surface.replaceAll('_', ' '), relativeTime(entry.createdAt, now)].filter(Boolean).join(' · ')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={({ pressed }) => [styles.entry, { backgroundColor: pressed ? colors.selected : colors.muted }, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }, first && styles.firstEntry, last && styles.lastEntry]}
    >
      <Text numberOfLines={open ? undefined : 1} style={[styles.title, { color: colors.foreground }]}>
        {summary.title}
      </Text>
      {!!summary.detail && (
        <Text numberOfLines={open ? undefined : 2} style={[styles.detail, { color: colors.mutedForeground }]}>
          {summary.detail}
        </Text>
      )}
      <Text style={[styles.meta, { color: tone }]}>{meta}</Text>
      {open && (
        <Text selectable style={[styles.input, { color: colors.foreground, backgroundColor: colors.secondary }]}>
          {JSON.stringify(entry.input, null, 2)}
        </Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  top: { paddingTop: 16 },
  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  intro: { fontSize: 14, lineHeight: 20, paddingHorizontal: 12, paddingBottom: 12 },
  entry: { paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
  firstEntry: { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  lastEntry: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  title: { fontSize: 16 },
  detail: { fontSize: 13, lineHeight: 18 },
  meta: { fontSize: 12, marginTop: 2 },
  input: { fontFamily: 'monospace', fontSize: 12, lineHeight: 16, padding: 8, borderRadius: 8, marginTop: 6 },
})
