import { useRef, useState } from 'react'
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { radii, useColors } from '../lib/theme.ts'

/** One choice of an action sheet; one with `items` opens them in its place, with Back. */
export type SheetItem = { label: string; danger?: boolean; run?: () => void; items?: SheetItem[]; back?: true }

export type SheetContent = { title?: string; items: SheetItem[] }

/**
 * The phone's menus (a chat's long-press menu, +, Move ▾): a sheet of choices from the bottom over a scrim, with
 * Cancel; tapping the scrim cancels too. Drawn the same on iOS and Android, as the sketch has it.
 */
export function ActionSheet({ sheet, onClose }: { sheet: SheetContent | undefined; onClose: () => void }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  // The last sheet stays drawn while it fades out.
  const [shown, setShown] = useState(sheet)
  if (sheet && sheet !== shown) setShown(sheet)
  // The submenu open in this sheet; each sheet opens at its top level.
  const [open, setOpen] = useState<{ sheet: SheetContent; item: SheetItem }>()
  const opened = open?.sheet === shown ? open?.item : undefined
  const setOpened = (item: SheetItem | undefined) => setOpen(item && shown && { sheet: shown, item })
  const items = opened ? [{ label: '‹ Back', back: true as const, run: () => setOpened(undefined) }, ...opened.items!] : (shown?.items ?? [])
  const title = opened ? opened.label : shown?.title
  // iOS can't present an alert or another modal while this one is going, so a choice runs once it has gone.
  const pending = useRef<() => void>(undefined)

  const choose = (item: SheetItem) => {
    if (item.items) return setOpened(item)
    if (item.back) return item.run?.()
    onClose()
    if (Platform.OS === 'ios') pending.current = item.run
    else item.run?.()
  }
  const dismissed = () => {
    const run = pending.current
    pending.current = undefined
    run?.()
  }

  return (
    <Modal
      visible={!!sheet}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={dismissed}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Pressable accessibilityLabel="Cancel" style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <View style={[styles.group, { backgroundColor: colors.popover }]}>
          {title ? (
            <Text numberOfLines={2} style={[styles.title, { color: colors.mutedForeground, borderBottomColor: colors.border }]}>
              {title}
            </Text>
          ) : null}
          <ScrollView bounces={false} style={styles.list}>
            {items.map((item, index) => (
              <Pressable
                key={index}
                accessibilityRole="button"
                onPress={() => choose(item)}
                style={({ pressed }) => [
                  styles.item,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                  pressed && { backgroundColor: colors.selected },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.label,
                    { color: item.danger ? colors.destructiveForeground : item.back ? colors.mutedForeground : colors.foreground },
                  ]}
                >
                  {item.label}
                </Text>
                {item.items ? <Text style={[styles.label, { color: colors.mutedForeground }]}>›</Text> : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.group, styles.item, styles.cancel, { backgroundColor: pressed ? colors.selected : colors.popover }]}
        >
          <Text style={[styles.label, styles.cancelLabel, { color: colors.foreground }]}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFill },
  sheet: { position: 'absolute', left: 8, right: 8, bottom: 0, gap: 8 },
  group: { borderRadius: radii.xl, overflow: 'hidden' },
  list: { maxHeight: 440 },
  title: { textAlign: 'center', fontSize: 13, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  item: { minHeight: 54, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  label: { fontSize: 17, flexShrink: 1 },
  cancel: { justifyContent: 'center' },
  cancelLabel: { fontWeight: '600' },
})
