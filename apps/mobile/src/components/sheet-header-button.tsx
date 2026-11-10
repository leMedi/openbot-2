import { Pressable, StyleSheet, Text } from 'react-native'
import { useColors } from '../lib/theme.ts'

/** A sheet's header action, as iOS draws them in text: Cancel, or the sheet's own action in bold (Create). */
export function SheetHeaderButton({ label, onPress, enabled = true, strong = false }: { label: string; onPress: () => void; enabled?: boolean; strong?: boolean }) {
  const colors = useColors()
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !enabled }} disabled={!enabled} hitSlop={8} onPress={onPress} style={styles.button}>
      <Text style={[styles.label, { color: colors.foreground, fontWeight: strong ? '600' : '400', opacity: enabled ? 1 : 0.4 }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 6 },
  label: { fontSize: 17 },
})
