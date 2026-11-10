import type { FactChanges, FactInfo, FactTier, NewFact as NewFactInput } from '@openbot/api-contract'
import { factImportances, factOrigin, factTierSections } from '@openbot/client'
import { router, Stack } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text } from 'react-native'
import { FieldRow, Group, GroupedScroll, Loading, Note, Row, SegmentedRow } from './grouped.tsx'
import { errorMessage } from '../lib/errors.ts'
import { useColors } from '../lib/theme.ts'
import { statusNote, useSaveQueue } from '../lib/save-queue.ts'
import { useLoadOnFocus } from '../lib/use-load.ts'
import { useSaveSoon } from '../lib/use-save-soon.ts'

/** The longest fact, as the instance's `maxFactLength` (in @openbot/core) refuses more. */
const maxFactLength = 500

/** Where the facts edited live, shared memory or a bot's memory, and how its changes reach every bot. */
export type FactScope = {
  list: () => Promise<FactInfo[]>
  add: (fact: NewFactInput) => Promise<FactInfo>
  edit: (factId: number, changes: FactChanges) => Promise<FactInfo>
  remove: (factId: number) => Promise<void>
  /** Who sees a change, e.g. "Every bot" or "Rex". */
  who: string
}

/**
 * A fact (`factId`), edited as the web edits one: its text saves as typed (an emptied text puts the old one back once
 * left), its tier and importance at once, and Delete removes it.
 */
export function EditFact({ factId, scope }: { factId: number; scope: FactScope }) {
  const facts = useLoadOnFocus(useCallback(() => scope.list(), [scope]))
  const fact = facts.data?.find((each) => each.id === factId)
  // What the owner typed; until then, the fact as it is.
  const [typed, setTyped] = useState<string>()
  const text = typed ?? fact?.content
  const { status, run } = useSaveQueue()
  const save = (changes: FactChanges) =>
    void run(async () => {
      const saved = await scope.edit(factId, changes)
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
    Alert.alert('Delete this fact?', `${scope.who} forgets it from its next run. This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          // A pending edit would land on the deleted fact as the screen closes.
          saveText.cancel()
          void scope
            .remove(factId)
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
        <Group note={statusNote(status, factOrigin(fact))}>
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

/** A new fact for `tier`, added with the header's Add. */
export function NewFact({ tier: initialTier, scope }: { tier: FactTier; scope: FactScope }) {
  const colors = useColors()
  const [text, setText] = useState('')
  const [tier, setTier] = useState(initialTier)
  const [importance, setImportance] = useState(3)
  const [adding, setAdding] = useState(false)

  const add = async () => {
    setAdding(true)
    try {
      await scope.add({ tier, text: text.trim(), importance })
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
        <Group note={`${scope.who} sees it from its next run.`}>
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
