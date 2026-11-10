import type { NewRoutine, RoutineChanges, RoutineInfo, RoutineRunInfo } from '@openbot/api-contract'
import {
  applyRoutineEvent,
  applyRunEvent,
  clockTime,
  defaultSchedule,
  deleteWarnings,
  describeSchedule,
  type EveryUnit,
  everyUnitLabels,
  formatInstant,
  localDate,
  quarterHours,
  runOutcomes,
  scheduleAliases,
  type ScheduleForm,
  scheduleForm,
  type ScheduleKind,
  scheduleKindLabels,
  scheduleText,
  switchKind,
  useLiveEvents,
  weekdayNames,
} from '@openbot/client'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native'
import { ActionSheet, type SheetContent } from '../../components/action-sheet.tsx'
import { FieldRow, Group, GroupedScroll, Loading, Note, Row, SwitchRow } from '../../components/grouped.tsx'
import { statusNote, useSaveQueue } from '../../lib/save-queue.ts'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { useOwnerTimeZone } from '../../lib/owner-time-zone.ts'
import { useColors } from '../../lib/theme.ts'
import { useLoadOnFocus } from '../../lib/use-load.ts'
import { useSaveSoon } from '../../lib/use-save-soon.ts'

/** The longest name and instruction, as the instance refuses more. */
const maxNameLength = 120
const maxPromptLength = 20_000

/**
 * A routine's editor, pushed from a bot's Routines, a routine chip in a chat or a search hit; `new` for a routine the
 * owner is creating. As the web's: Active, its name and instruction (saved as typed), when it runs (pickers save at
 * once), its next run, Test run, its run history, live, and Delete. A new routine is created once its name and
 * instruction are filled in.
 */
export default function Routine() {
  const { routineId, botId } = useLocalSearchParams<{ routineId: string; botId: string }>()
  const { api } = useInstance()
  const timeZone = useOwnerTimeZone()
  const routines = useLoadOnFocus(useCallback(() => api.routines.list({ botId }), [api, botId]))
  const { update, reload } = routines
  useLiveEvents((event) => {
    if (event.type === 'hello' && !event.resumed) return reload()
    update((current) => applyRoutineEvent(current, botId, event)!)
  })

  if (routineId === 'new') {
    return (
      <NewRoutineEditor
        botId={botId}
        timeZone={timeZone}
        onCreated={(created) => {
          update((current) => applyRoutineEvent(current, botId, { type: 'routine.updated', routine: created })!)
          // A list still loading may have been read before it was created.
          reload()
          router.setParams({ routineId: created.id })
        }}
      />
    )
  }
  const routine = routines.data?.find((each) => each.id === routineId)
  if (!routine) {
    return (
      <>
        <Stack.Screen options={{ title: 'Routine' }} />
        <GroupedScroll>
          {routines.error && !routines.data ? <Note tone="error">{`Couldn't load it: ${routines.error}`}</Note> : routines.data ? <Note>This routine is gone.</Note> : <Loading />}
        </GroupedScroll>
      </>
    )
  }
  return <RoutineEditor key={routine.id} routine={routine} timeZone={timeZone} />
}

function RoutineEditor({ routine, timeZone }: { routine: RoutineInfo; timeZone: string | undefined }) {
  const { api } = useInstance()
  const { status, run } = useSaveQueue()
  const [starting, setStarting] = useState(false)
  const ids = { botId: routine.botId, routineId: routine.id }
  // The answer arrives as `routine.updated` too, which shows it.
  const save = (changes: RoutineChanges) => run(() => api.routines.update({ ...ids, ...changes }))

  const name = useRoutineText(routine.name, (text) => void save({ name: text }))
  const prompt = useRoutineText(routine.prompt, (text) => void save({ prompt: text }))

  const testRun = async () => {
    setStarting(true)
    await run(() => api.routines.testRun(ids), "Couldn't start a test run")
    setStarting(false)
  }

  const confirmDelete = () =>
    Alert.alert(`Delete ${routine.name}?`, deleteWarnings.routine, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          name.cancel()
          prompt.cancel()
          void api.routines
            .delete(ids)
            .then(() => router.back())
            .catch((caught) => Alert.alert("Couldn't delete it", errorMessage(caught)))
        },
      },
    ])

  const running = routine.running || starting
  return (
    <>
      <Stack.Screen options={{ title: routine.name }} />
      <GroupedScroll>
        <Group note={statusNote(status, routine.createdBy === 'bot' ? 'The bot set this routine up; once you change it, it speaks for you.' : 'Changes save as you type.')}>
          <SwitchRow label="Active" value={routine.enabled} onChange={(active) => void run(() => (active ? api.routines.resume(ids) : api.routines.pause(ids)))} />
        </Group>
        <Group label="Name">
          <FieldRow accessibilityLabel="Name" value={name.text} onChangeText={name.change} onEndEditing={name.leave} placeholder="Name this routine" maxLength={maxNameLength} returnKeyType="done" />
        </Group>
        <Group label="Instruction">
          <FieldRow
            accessibilityLabel="Instruction"
            value={prompt.text}
            onChangeText={prompt.change}
            onEndEditing={prompt.leave}
            placeholder="What should this routine do each time it runs?"
            maxLength={maxPromptLength}
            multiline
          />
        </Group>
        <ScheduleGroup
          schedule={routine.schedule}
          timeZone={timeZone}
          nextRun={routine.enabled && routine.nextRunAt !== null ? `Next run ${formatInstant(routine.nextRunAt, timeZone)}.` : undefined}
          onSave={(schedule) => save({ schedule })}
        />
        <Group>
          <Row label={running ? 'Running…' : 'Test run'} tone="link" busy={running} onPress={() => void testRun()} />
        </Group>
        <RunHistory routine={routine} timeZone={timeZone} />
        <Group>
          <Row label="Delete routine" tone="danger" onPress={confirmDelete} />
        </Group>
      </GroupedScroll>
    </>
  )
}

/**
 * A routine's text, saved as typed: `text` is what the field shows, `change` takes each keystroke, `leave` its end of
 * editing. An emptied field isn't saved and shows the saved text again once left.
 */
function useRoutineText(saved: string, save: (text: string) => void) {
  const [typed, setTyped] = useState<string>()
  const editing = useRef(false)
  // Changed elsewhere, e.g. by the bot: shown as it is, unless the owner is typing.
  useEffect(() => {
    if (!editing.current) setTyped(undefined)
  }, [saved])
  const saver = useSaveSoon((final) => {
    if (final) editing.current = false
    if (typed === undefined) return
    const trimmed = typed.trim()
    if (!trimmed) return final && setTyped(undefined)
    if (trimmed !== saved.trim()) save(trimmed)
  })
  return {
    text: typed ?? saved,
    change: (value: string) => {
      editing.current = true
      setTyped(value)
      saver.soon()
    },
    leave: saver.now,
    cancel: saver.cancel,
  }
}

/**
 * A routine the owner is creating: created, with Active as they left it, once its name and instruction are filled in
 * and a field is left or the screen closes. Discard drops it.
 */
function NewRoutineEditor({ botId, timeZone, onCreated }: { botId: string; timeZone: string | undefined; onCreated: (routine: RoutineInfo) => void }) {
  const { api } = useInstance()
  const [draft, setDraft] = useState<NewRoutine>({ name: '', prompt: '', schedule: defaultSchedule, enabled: true })
  const { status, setStatus } = useSaveQueue()
  const creating = useRef(false)
  const latest = useRef(draft)

  /** Creates it once it can be; `open` shows it once created (not as the screen closes, when it's gone). */
  async function create(values: NewRoutine, open = true) {
    setDraft(values)
    latest.current = values
    if (creating.current || !values.name.trim() || !values.prompt.trim()) return
    creating.current = true
    setStatus({ saving: true })
    let created: RoutineInfo
    try {
      created = await api.routines.create({ botId, ...values, name: values.name.trim(), prompt: values.prompt.trim() })
    } catch (caught) {
      creating.current = false
      setStatus({ saving: false, error: `Couldn't create it: ${errorMessage(caught)}` })
      return
    }
    // Edited while it was being created: those edits follow, best effort; it shows as saved either way.
    const edited = latest.current
    const ids = { botId, routineId: created.id }
    try {
      if (edited.name.trim() !== created.name || edited.prompt.trim() !== created.prompt || edited.schedule !== values.schedule) {
        created = await api.routines.update({ ...ids, name: edited.name.trim() || created.name, prompt: edited.prompt.trim() || created.prompt, schedule: edited.schedule })
      }
      if (edited.enabled !== values.enabled) created = await (edited.enabled ? api.routines.resume(ids) : api.routines.pause(ids))
    } catch {
      // Shown as it was created.
    }
    if (open) onCreated(created)
  }

  const edit = (changes: Partial<NewRoutine>) => {
    const next = { ...latest.current, ...changes }
    setDraft(next)
    latest.current = next
  }
  // Created as a field is left, not as the owner pauses typing, which would move them to the routine mid-sentence;
  // and as the screen closes (Android's back ends no editing), unless discarded.
  const discarded = useRef(false)
  const createLatest = useRef(() => {})
  useLayoutEffect(() => {
    createLatest.current = () => void create(latest.current, false)
  })
  useEffect(
    () => () => {
      if (!discarded.current) createLatest.current()
    },
    [],
  )
  return (
    <>
      <Stack.Screen options={{ title: 'New routine' }} />
      <GroupedScroll>
        <Group note={statusNote(status, 'It is created once it has a name and an instruction, as you leave the field.')}>
          <SwitchRow label="Active" value={draft.enabled ?? true} onChange={(enabled) => void create({ ...latest.current, enabled })} />
        </Group>
        <Group label="Name">
          <FieldRow
            accessibilityLabel="Name"
            value={draft.name}
            onChangeText={(name) => edit({ name })}
            onEndEditing={() => void create(latest.current)}
            placeholder="Name this routine"
            maxLength={maxNameLength}
            returnKeyType="done"
            autoFocus
          />
        </Group>
        <Group label="Instruction">
          <FieldRow
            accessibilityLabel="Instruction"
            value={draft.prompt}
            onChangeText={(prompt) => edit({ prompt })}
            onEndEditing={() => void create(latest.current)}
            placeholder="What should this routine do each time it runs?"
            maxLength={maxPromptLength}
            multiline
          />
        </Group>
        <ScheduleGroup schedule={draft.schedule} timeZone={timeZone} onSave={(schedule) => void create({ ...latest.current, schedule })} />
        <Group label="Run history" note="No runs yet" />
        <Group>
          <Row
            label="Discard"
            tone="danger"
            onPress={() => {
              discarded.current = true
              router.back()
            }}
          />
        </Group>
      </GroupedScroll>
    </>
  )
}

/**
 * "When to run", as the web's: what kind of schedule and its details, each chosen from a sheet and saved at once (typed
 * values once their field is left), with the schedule in words and the time zone below.
 */
function ScheduleGroup({
  schedule,
  timeZone,
  nextRun,
  onSave,
}: {
  schedule: string
  timeZone: string | undefined
  nextRun?: string
  /** Saves it; false when the instance refused it, which shows the saved schedule again. */
  onSave: (schedule: string) => Promise<boolean> | void
}) {
  const colors = useColors()
  const [form, setForm] = useState(() => scheduleForm(schedule))
  const [sheet, setSheet] = useState<SheetContent>()
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setForm(scheduleForm(schedule))
  }, [schedule])
  const sentence = describeSchedule(scheduleText(form))

  function commit(next: ScheduleForm) {
    editing.current = false
    setForm(next)
    const text = scheduleText(next)
    if (!text || text === schedule.trim()) return
    void Promise.resolve(onSave(text)).then((saved) => {
      if (saved === false && !editing.current) setForm(scheduleForm(schedule))
    })
  }
  const typing = (next: ScheduleForm) => {
    editing.current = true
    setForm(next)
  }

  const choose = <T,>(title: string, options: readonly (readonly [T, string])[], pick: (value: T) => void) =>
    setSheet({ title, items: options.map(([value, label]) => ({ label, run: () => pick(value) })) })
  const time = 'time' in form ? form.time : undefined
  const timeRow = time && (
    <Row key="time" label="At" value={clockTime(time)} onPress={() => choose('At', timeChoices(time), (picked) => 'time' in form && commit({ ...form, time: picked }))} />
  )

  const details = []
  switch (form.kind) {
    case 'daily':
    case 'weekdays':
      details.push(timeRow)
      break
    case 'weekly':
      details.push(
        <Row key="weekday" label="On" value={weekdayNames[form.weekday]} onPress={() => choose('On', weekdayNames.map((day, index) => [index, day] as const), (weekday) => commit({ ...form, weekday }))} />,
        timeRow,
      )
      break
    case 'monthly':
      details.push(
        <Row
          key="day"
          label="On day"
          value={String(form.day)}
          onPress={() => choose('On day', Array.from({ length: 31 }, (_, index) => [index + 1, `Day ${index + 1}`] as const), (day) => commit({ ...form, day }))}
        />,
        timeRow,
      )
      break
    case 'alias':
      details.push(<Row key="alias" label="Preset" value={form.alias} onPress={() => choose('Preset', scheduleAliases.map((alias) => [alias, alias] as const), (alias) => commit({ ...form, alias }))} />)
      break
    case 'every':
      details.push(
        <FieldRow
          key="amount"
          label="Every"
          value={String(form.amount)}
          keyboardType="number-pad"
          onChangeText={(value) => typing({ ...form, amount: Math.max(1, Math.floor(Number(value)) || 1) })}
          onEndEditing={() => commit(form)}
          returnKeyType="done"
        />,
        <Row
          key="unit"
          label="Unit"
          value={everyUnitLabels[form.unit]}
          onPress={() => choose('Unit', Object.entries(everyUnitLabels) as [EveryUnit, string][], (unit) => commit({ ...form, unit }))}
        />,
      )
      break
    case 'once':
      details.push(
        <FieldRow
          key="at"
          label="At"
          value={form.at.replace('T', ' ')}
          placeholder="2026-11-12 09:00"
          autoCorrect={false}
          onChangeText={(value) => typing({ ...form, at: value.trim().replace(' ', 'T').slice(0, 16) })}
          onEndEditing={() => commit(form)}
          returnKeyType="done"
        />,
      )
      break
    case 'cron':
      details.push(
        <FieldRow
          key="cron"
          accessibilityLabel="Cron expression"
          value={form.expression}
          placeholder="minute hour day month weekday"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          onChangeText={(expression) => typing({ ...form, expression })}
          onEndEditing={() => commit(form)}
          returnKeyType="done"
          style={styles.mono}
        />,
      )
  }

  const zone = `Times are in ${timeZone?.replaceAll('_', ' ') ?? 'your time zone'}, which you change in Settings → General.`
  return (
    <>
      <Group label="When to run" note={nextRun ? `${nextRun} ${zone}` : zone}>
        <Row
          label="Repeats"
          value={scheduleKindLabels[form.kind]}
          onPress={() =>
            choose('Repeats', Object.entries(scheduleKindLabels) as [ScheduleKind, string][], (kind) =>
              commit(switchKind(form, kind, localDate(Date.now() + 24 * 60 * 60 * 1000, timeZone))),
            )
          }
        />
        {details}
        <View key="sentence" style={styles.sentence}>
          <Text style={[styles.sentenceText, { color: sentence ? colors.foreground : colors.destructiveForeground }]}>{sentence ?? 'Not a valid schedule.'}</Text>
        </View>
      </Group>
      <ActionSheet sheet={sheet} onClose={() => setSheet(undefined)} />
    </>
  )
}

/** The time picker's choices: every quarter hour, with `time` first when it isn't one. */
const timeChoices = (time: string) => (quarterHours.includes(time) ? quarterHours : [time, ...quarterHours]).map((entry) => [entry, clockTime(entry)] as const)

/** The routine's runs, newest first, kept up to date live: when each was due, and how it went. */
function RunHistory({ routine, timeZone }: { routine: RoutineInfo; timeZone: string | undefined }) {
  const { api } = useInstance()
  const colors = useColors()
  const { botId, id: routineId } = routine
  const runs = useLoadOnFocus(useCallback(() => api.routines.runs({ botId, routineId }), [api, botId, routineId]))
  const { update, reload } = runs
  useLiveEvents((event) => {
    if (event.type === 'hello' && !event.resumed) return reload()
    update((current) => applyRunEvent(current, routineId, event)!)
  })

  const toneColor = { ok: colors.greenForeground, error: colors.destructiveForeground, muted: colors.mutedForeground }
  const mark = (run: RoutineRunInfo) =>
    run.status === 'running' ? (
      <ActivityIndicator accessibilityLabel="Running" color={colors.mutedForeground} />
    ) : (
      <Text accessibilityLabel={runOutcomes[run.status].label} style={[styles.mark, { color: toneColor[runOutcomes[run.status].tone] }]}>
        {runOutcomes[run.status].mark}
      </Text>
    )
  return (
    <Group
      label="Run history"
      note={runs.error && !runs.data ? `Couldn't load its runs: ${runs.error}` : runs.data && !runs.data.length ? 'No runs yet' : undefined}
    >
      {runs.data?.map((run) => (
        <View key={run.id} style={styles.run}>
          <View style={styles.runText}>
            <Text style={[styles.runWhen, { color: colors.foreground }]}>{formatInstant(run.scheduledFor, timeZone)}</Text>
            {(run.test || !!run.message) && (
              <Text style={[styles.runNote, { color: colors.mutedForeground }]}>{[run.test && 'Test', run.message && 'messaged you'].filter(Boolean).join(' · ')}</Text>
            )}
          </View>
          {mark(run)}
        </View>
      ))}
    </Group>
  )
}

const styles = StyleSheet.create({
  mono: { fontFamily: 'monospace' },
  sentence: { paddingHorizontal: 12, paddingVertical: 10 },
  sentenceText: { fontSize: 15 },
  run: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8 },
  runText: { flex: 1 },
  runWhen: { fontSize: 15, fontVariant: ['tabular-nums'] },
  runNote: { fontSize: 12 },
  mark: { fontSize: 15, fontWeight: '600' },
})
