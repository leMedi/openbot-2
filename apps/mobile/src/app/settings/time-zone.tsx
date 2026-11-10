import { knownTimeZones, matchTimeZones } from '@openbot/client'
import { router, Stack } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Alert, FlatList, StyleSheet, View } from 'react-native'
import { Loading, Note, Row } from '../../components/grouped.tsx'
import { SearchField } from '../../components/search-field.tsx'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { useColors } from '../../lib/theme.ts'
import { useLoadOnFocus } from '../../lib/use-load.ts'

/** Settings → General → Time zone: every IANA zone the phone knows, searchable; a tap sets it and goes back. */
export default function TimeZone() {
  const { api } = useInstance()
  const colors = useColors()
  const settings = useLoadOnFocus(useCallback(() => api.general.getSettings(), [api]))
  // Hermes can't list time zones, so the instance does; the phone works out their offsets.
  const names = useLoadOnFocus(useCallback(() => api.general.timeZones(), [api]))
  const zones = useMemo(() => (names.data ? knownTimeZones(names.data) : []), [names.data])
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState<string>()
  const matches = useMemo(() => matchTimeZones(zones, query), [zones, query])

  const choose = async (timeZone: string) => {
    setSaving(timeZone)
    try {
      await api.general.updateSettings({ timeZone })
      router.back()
    } catch (caught) {
      setSaving(undefined)
      Alert.alert("Couldn't set the time zone", errorMessage(caught))
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Time zone' }} />
      <FlatList
        data={matches}
        keyExtractor={(zone) => zone.timeZone}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.background }}
        ListHeaderComponent={<SearchField query={query} searching={false} onQuery={setQuery} onSearching={() => {}} placeholder="Search, e.g. Paris or GMT+9" label="Search time zones" />}
        ListEmptyComponent={
          names.error ? <Note tone="error">{`Couldn't load the time zones: ${names.error}`}</Note> : names.data ? <Note>No time zone matches.</Note> : <Loading />
        }
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
        renderItem={({ item }) => (
          <View style={styles.item}>
            <Row
              label={item.timeZone.replaceAll('_', ' ')}
              value={item.offset}
              checked={item.timeZone === settings.data?.timeZone}
              busy={saving === item.timeZone}
              disabled={!!saving}
              onPress={() => void choose(item.timeZone)}
            />
          </View>
        )}
      />
    </>
  )
}

const styles = StyleSheet.create({
  item: { paddingHorizontal: 4 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
})
