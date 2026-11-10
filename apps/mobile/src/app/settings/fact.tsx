import { type FactChanges, type FactInfo, type FactTier, factTiers } from '@openbot/api-contract'
import { factImportances, factOrigin, factTierSections } from '@openbot/client'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text } from 'react-native'
import { FieldRow, Group, GroupedScroll, Loading, Note, Row, SegmentedRow } from '../../components/grouped.tsx'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { useColors } from '../../lib/theme.ts'
import { useLoadOnFocus } from '../../lib/use-load.ts'
import { useSaveSoon } from '../../lib/use-save-soon.ts'

/** The longest fact, as the instance's `maxFactLength` (in @openbot/core) refuses more. */
const maxFactLength = 500

/**
 * A shared fact (`factId`), edited as the web edits one: its text saves when the field is left (an emptied text puts
 * the old one back), its tier and importance at once, and Delete removes it. With `tier` instead, a new fact for that
 * tier, added with the header's Add.
 */
export default function Fact() {
  const params = useLocalSearchParams<{ factId?: string; tier?: string }>()
  if (params.factId) return <EditFact factId={Number(params.factId)} />
  const tier = factTiers.find((each) => each === params.tier) ?? 'profile'
  return <NewFact tier={tier} />
}

function EditFact({ factId }: { factId: number }) {
  const { api } = useInstance()
  const facts = useLoadOnFocus(useCallback(() => api.sharedMemory.list(), [api]))
  const fact = facts.data?.find((each) => each.id === factId)
  // What the owner typed; until then, the fact as it is.
  const [typed, setTyped] = useState<string>()
  const text = typed ?? fact?.content
  const [status, setStatus] = useState<{ saving: boolean; error?: string }>({ saving: false })
  // Changes go one after another, so they land in the order the owner made them.
  const queue = useRef(Promise.resolve())

  const run = (work: () => Promise<void>) => {
    setStatus({ saving: true })
    queue.current = queue.current.then(async () => {
      try {
        await work()
        setStatus({ saving: false })
      } catch (caught) {
        setStatus({ saving: false, error: errorMessage(caught) })
      }
    })
  }
  const save = (changes: FactChanges) =>
    run(async () => {
      const saved = await api.sharedMemory.edit({ factId, ...changes })
      facts.setData((facts.data ?? []).map((each) => (each.id === saved.id ? saved : each)))
    })

  const saveText = useSaveSoon((final) => {
    if (!fact || text === undefined) return
    const trimmed = text.trim()
    // An emptied fact puts the old text back once the field is left; Delete removes it.
    if (!trimmed) return final && setTyped(undefined)
    if (trimmed !== fact.content) save({ text: trimmed })
  })

  const confirmDelete = () =>
    Alert.alert('Delete this fact?', "Every bot forgets it from its next run. This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          // A pending edit would land on the deleted fact as the screen closes.
          saveText.cancel()
          void api.sharedMemory
            .delete({ factId })
            .then(() => router.back())
            .catch((caught) => Alert.alert("Couldn't delete it", errorMessage(caught)))
        },
      },
    ])

  if (!fact) {
    return (
      <>
        <Stack.Screen options={{ title: 'Fact' }} />
        <GroupedScroll>
          {facts.error ? <Note tone="error">{`Couldn't load it: ${facts.error}`}</Note> : facts.data ? <Note>This fact is gone.</Note> : <Loading />}
        </GroupedScroll>
      </>
    )
  }
  return (
    <>
      <Stack.Screen options={{ title: 'Fact' }} />
      <GroupedScroll>
        <Group note={status.error ? `Couldn't save: ${status.error}` : status.saving ? 'Saving…' : factOrigin(fact)}>
          <FieldRow
            accessibilityLabel="Fact"
            value={text ?? ''}
            onChangeText={(value) => {
              setTyped(value)
              saveText.soon()
            }}
            onEndEditing={saveText.now}
            maxLength={maxFactLength}
            multiline
          />
        </Group>
        <FactOptions fact={fact} onChange={save} />
        <Group>
          <Row label="Delete" tone="danger" onPress={confirmDelete} />
        </Group>
      </GroupedScroll>
    </>
  )
}

function NewFact({ tier: initialTier }: { tier: FactTier }) {
  const { api } = useInstance()
  const colors = useColors()
  const [text, setText] = useState('')
  const [tier, setTier] = useState(initialTier)
  const [importance, setImportance] = useState(3)
  const [adding, setAdding] = useState(false)

  const add = async () => {
    setAdding(true)
    try {
      await api.sharedMemory.add({ tier, text: text.trim(), importance })
      router.back()
    } catch (caught) {
      setAdding(false)
      Alert.alert("Couldn't add it", errorMessage(caught))
    }
  }

  const canAdd = !!text.trim() && !adding
  return (
    <>
      <Stack.Screen
        options={{
          title: 'New fact',
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canAdd }} disabled={!canAdd} hitSlop={8} onPress={() => void add()}>
              <Text style={[styles.add, { color: colors.foreground, opacity: canAdd ? 1 : 0.4 }]}>Add</Text>
            </Pressable>
          ),
        }}
      />
      <GroupedScroll>
        <Group note="Every bot sees it from its next run.">
          <FieldRow
            accessibilityLabel="New fact"
            value={text}
            onChangeText={setText}
            placeholder="Something your bots should remember"
            maxLength={maxFactLength}
            multiline
            autoFocus
          />
        </Group>
        <FactOptions
          fact={{ tier, importance }}
          onChange={(changes) => {
            if (changes.tier) setTier(changes.tier)
            if (changes.importance) setImportance(changes.importance)
          }}
        />
      </GroupedScroll>
    </>
  )
}

/** A fact's tier and importance, as lists of options. */
function FactOptions({ fact, onChange }: { fact: Pick<FactInfo, 'tier' | 'importance'>; onChange: (changes: FactChanges) => void }) {
  return (
    <>
      <Group label="Tier">
        {factTierSections.map(({ tier, title, hint }) => (
          <Row key={tier} label={title} detail={hint} checked={fact.tier === tier} onPress={() => fact.tier !== tier && onChange({ tier })} />
        ))}
      </Group>
      <Group label="Importance" note="How much it matters, from 1 (least) to 5.">
        <SegmentedRow
          label="Importance"
          options={factImportances.map((importance) => ({ value: importance, label: String(importance) }))}
          value={fact.importance}
          onChange={(importance) => onChange({ importance })}
        />
      </Group>
    </>
  )
}

const styles = StyleSheet.create({
  add: { fontSize: 17, fontWeight: '600' },
})
