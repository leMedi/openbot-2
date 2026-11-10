import { Children, isValidElement, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, type ScrollViewProps, StyleSheet, Switch, Text, TextInput, type TextInputProps, View } from 'react-native'
import { useColors } from '../lib/theme.ts'
import { ChevronIcon } from './icons.tsx'

/**
 * A grouped list screen, as iOS's Settings and the sketch draw it: groups of rows on rounded cards, each with an
 * optional label above and note below. Used by the Settings sheet's screens.
 */
export function GroupedScroll({ children, ...props }: { children: ReactNode } & Omit<ScrollViewProps, 'children'>) {
  const colors = useColors()
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.scroll}
      {...props}
    >
      {children}
    </ScrollView>
  )
}

/** A group of rows, separated by hairlines. */
export function Group({ label, note, children }: { label?: string; note?: ReactNode; children?: ReactNode }) {
  const colors = useColors()
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View>
      {label ? (
        <Text accessibilityRole="header" style={[styles.label, { color: colors.mutedForeground }]}>
          {label.toUpperCase()}
        </Text>
      ) : null}
      {rows.length > 0 && (
        <View style={[styles.card, { backgroundColor: colors.muted }]}>
          {rows.map((row, index) => (
            <View key={row.key ?? index} style={index > 0 && [styles.separated, { borderTopColor: colors.border }]}>
              {row}
            </View>
          ))}
        </View>
      )}
      {note ? <Text style={[styles.note, { color: colors.mutedForeground }]}>{note}</Text> : null}
    </View>
  )
}

/** Text in a group's note or an empty group's place, e.g. why something couldn't load. */
export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'error' | 'warning' }) {
  const colors = useColors()
  const color = tone === 'error' ? colors.destructiveForeground : tone === 'warning' ? colors.amberForeground : colors.mutedForeground
  return <Text style={[styles.loose, { color }]}>{children}</Text>
}

export function Loading() {
  const colors = useColors()
  return <ActivityIndicator style={styles.loading} color={colors.mutedForeground} />
}

/**
 * A row: its label, then a value in grey and a chevron when it opens something. `tone` `link` is an action (blue),
 * `danger` a destructive one (red, centred); `external` marks a row that leaves the app (↗).
 */
export function Row({
  label,
  detail,
  value,
  onPress,
  tone = 'plain',
  checked,
  chevron = !!onPress && tone === 'plain' && checked === undefined,
  external = false,
  disabled = false,
  busy = false,
  icon,
  accessibilityLabel,
}: {
  label: string
  /** A second line under the label. */
  detail?: string
  value?: string
  onPress?: () => void
  tone?: 'plain' | 'link' | 'danger'
  chevron?: boolean
  /** A choice in a list of options: the chosen one gets a check mark. */
  checked?: boolean
  external?: boolean
  disabled?: boolean
  busy?: boolean
  icon?: ReactNode
  accessibilityLabel?: string
}) {
  const colors = useColors()
  const color = disabled ? colors.disabled : tone === 'link' ? colors.link : tone === 'danger' ? colors.destructiveForeground : colors.foreground
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled || !onPress, selected: checked, busy }}
      disabled={disabled || !onPress || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.selected }]}
    >
      {icon}
      <View style={styles.labels}>
        <Text style={[styles.rowLabel, { color, textAlign: tone === 'danger' ? 'center' : 'left' }]}>
          {label}
          {external ? ' ↗' : ''}
        </Text>
        {detail ? (
          <Text numberOfLines={2} style={[styles.detail, { color: colors.mutedForeground }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text numberOfLines={1} style={[styles.value, { color: colors.mutedForeground }]}>
          {value}
        </Text>
      ) : null}
      {busy ? <ActivityIndicator color={colors.mutedForeground} /> : null}
      {checked ? <Text style={[styles.check, { color: colors.link }]}>✓</Text> : null}
      {chevron ? (
        <ChevronIcon folded size={14} color={colors.faint} />
      ) : null}
    </Pressable>
  )
}

/** A row with a switch, e.g. a bot granted a plugin account. */
export function SwitchRow({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const colors = useColors()
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, styles.labels, { color: colors.foreground }]}>{label}</Text>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} />
    </View>
  )
}

/** A row of options side by side, as iOS's segmented control: the chosen one raised. */
export function SegmentedRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  const colors = useColors()
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[styles.row, styles.segments]}>
      {options.map((option) => {
        const chosen = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen }}
            accessibilityLabel={`${label} ${option.label}`}
            onPress={() => !chosen && onChange(option.value)}
            style={({ pressed }) => [styles.segment, chosen && { backgroundColor: colors.background }, pressed && !chosen && { backgroundColor: colors.selected }]}
          >
            <Text style={[styles.segmentLabel, { color: colors.foreground, fontWeight: chosen ? '600' : '400' }]}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** A row holding a text field, with an optional label before it. */
export function FieldRow({ label, multiline, ...props }: { label?: string } & TextInputProps) {
  const colors = useColors()
  return (
    <View style={[styles.row, multiline && styles.multilineRow]}>
      {label ? <Text style={[styles.rowLabel, styles.fieldLabel, { color: colors.foreground }]}>{label}</Text> : null}
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.faint}
        multiline={multiline}
        style={[styles.rowLabel, styles.field, multiline && styles.multiline, { color: colors.foreground }]}
        {...props}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40, gap: 24 },
  label: { fontSize: 12, letterSpacing: 0.6, paddingHorizontal: 12, paddingBottom: 6 },
  card: { borderRadius: 12, overflow: 'hidden' },
  separated: { borderTopWidth: StyleSheet.hairlineWidth },
  note: { fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingTop: 6 },
  loose: { fontSize: 14, lineHeight: 20, paddingHorizontal: 12 },
  loading: { marginTop: 48 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10 },
  labels: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 16 },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 1 },
  value: { fontSize: 15, maxWidth: '55%', flexShrink: 1 },
  check: { fontSize: 17, fontWeight: '600' },
  fieldLabel: { width: 96 },
  segments: { gap: 4, paddingHorizontal: 6, paddingVertical: 6 },
  segment: { flex: 1, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segmentLabel: { fontSize: 15 },
  field: { flex: 1, paddingVertical: 0, paddingHorizontal: 0, minWidth: 0 },
  multilineRow: { alignItems: 'flex-start' },
  multiline: { minHeight: 110, textAlignVertical: 'top' },
})
