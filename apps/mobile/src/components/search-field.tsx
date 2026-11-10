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
  placeholder = 'Search',
  label = 'Search messages, chats, files and routines',
  inset = true,
}: {
  query: string
  searching: boolean
  onQuery: (query: string) => void
  onSearching: (searching: boolean) => void
  placeholder?: string
  label?: string
  /** Its own side margins, as at the top of a list; off inside a padded screen. */
  inset?: boolean
}) {
  const colors = useColors()
  const field = useRef<TextInputInstance>(null)
  return (
    <View style={[styles.fieldRow, !inset && styles.flush]}>
      <View style={[styles.field, { backgroundColor: colors.secondary }]}>
        <SearchIcon color={colors.mutedForeground} />
        <TextInput
          ref={field}
          value={query}
          onChangeText={onQuery}
          onFocus={() => onSearching(true)}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel={label}
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
  flush: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, borderRadius: 10, paddingHorizontal: 10 },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  cancel: { fontSize: 16 },
})
