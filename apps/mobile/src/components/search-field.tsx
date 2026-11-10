import { useRef } from 'react'
import { Pressable, StyleSheet, Text, TextInput, type TextInputInstance, View } from 'react-native'
import { useColors } from '../lib/theme.ts'
import { SearchIcon } from './icons.tsx'

/**
 * The Chats list's search field, as the sketch has it, in the list so it scrolls with it under the large title (the
 * native header search bar overlapped the header's buttons on Android). Focusing it starts searching; Cancel ends it.
 */
export function SearchField({
  query,
  searching,
  onQuery,
  onSearching,
}: {
  query: string
  searching: boolean
  onQuery: (query: string) => void
  onSearching: (searching: boolean) => void
}) {
  const colors = useColors()
  const field = useRef<TextInputInstance>(null)
  return (
    <View style={styles.fieldRow}>
      <View style={[styles.field, { backgroundColor: colors.secondary }]}>
        <SearchIcon color={colors.mutedForeground} />
        <TextInput
          ref={field}
          value={query}
          onChangeText={onQuery}
          onFocus={() => onSearching(true)}
          placeholder="Search"
          placeholderTextColor={colors.mutedForeground}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel="Search messages, chats, files and routines"
          style={[styles.input, { color: colors.foreground }]}
        />
      </View>
      {searching && (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            field.current?.blur()
            onQuery('')
            onSearching(false)
          }}
        >
          <Text style={[styles.cancel, { color: colors.foreground }]}>Cancel</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, borderRadius: 10, paddingHorizontal: 10 },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  cancel: { fontSize: 16 },
})
