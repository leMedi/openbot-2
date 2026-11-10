import { type MessageInfo, previewText, quickReactions } from '@openbot/api-contract'
import { ownerReactor } from '@openbot/client'
import { useRef, useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { radii, useColors } from '../lib/theme.ts'

/**
 * A message's long-press menu, drawn as the phone's action sheets are: the message's line, Grok's quick reactions (those
 * the owner left marked, a tap toggling one), then Reply and Copy, and Cancel; tapping the scrim cancels too.
 */
export function MessageMenu({
  message,
  onClose,
  onReact,
  onReply,
  onCopy,
}: {
  message: MessageInfo | undefined
  onClose: () => void
  onReact: (message: MessageInfo, emoji: string) => void
  onReply?: (message: MessageInfo) => void
  onCopy: (message: MessageInfo) => void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  // The last message stays drawn while the sheet fades out.
  const [shown, setShown] = useState(message)
  if (message && message !== shown) setShown(message)
  // iOS can't present another modal while this one is going, so a choice runs once it has gone.
  const pending = useRef<() => void>(undefined)
  const choose = (run: () => void) => {
    onClose()
    if (Platform.OS === 'ios') pending.current = run
    else run()
  }
  const dismissed = () => {
    const run = pending.current
    pending.current = undefined
    run?.()
  }
  const own = (emoji: string) => !!shown?.reactions.some((reaction) => reaction.emoji === emoji && reaction.by === ownerReactor)
  const line = shown ? previewText(shown.text) || shown.attachments.map((file) => file.name).join(', ') : ''
  const items = shown
    ? [
        ...(onReply ? [{ label: 'Reply', run: () => onReply(shown) }] : []),
        ...(shown.text ? [{ label: 'Copy', run: () => onCopy(shown) }] : []),
      ]
    : []

  return (
    <Modal visible={!!message} transparent animationType="fade" onRequestClose={onClose} onDismiss={dismissed} statusBarTranslucent navigationBarTranslucent>
      <Pressable accessibilityLabel="Cancel" style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <View style={[styles.group, { backgroundColor: colors.popover }]}>
          {!!line && (
            <Text numberOfLines={2} style={[styles.title, { color: colors.mutedForeground, borderBottomColor: colors.border }]}>
              {shown?.author === 'owner' ? 'You' : shown?.authorName}: {line}
            </Text>
          )}
          <View accessibilityRole="toolbar" accessibilityLabel="Reactions" style={[styles.reactions, { borderBottomColor: colors.border }]}>
            {quickReactions.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={own(emoji) ? `Take back ${emoji}` : `React ${emoji}`}
                accessibilityState={{ selected: own(emoji) }}
                onPress={() => shown && choose(() => onReact(shown, emoji))}
                style={({ pressed }) => [
                  styles.reaction,
                  own(emoji) && { backgroundColor: colors.blueSubtle },
                  pressed && { backgroundColor: colors.selected, transform: [{ scale: 0.92 }] },
                ]}
              >
                <Text style={styles.emoji}>{emoji}</Text>
              </Pressable>
            ))}
          </View>
          {items.map((item, index) => (
            <Pressable
              key={item.label}
              accessibilityRole="button"
              onPress={() => choose(item.run)}
              style={({ pressed }) => [
                styles.item,
                index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                pressed && { backgroundColor: colors.selected },
              ]}
            >
              <Text style={[styles.label, { color: colors.foreground }]}>{item.label}</Text>
            </Pressable>
          ))}
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
  title: { textAlign: 'center', fontSize: 13, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  reactions: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  reaction: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 26 },
  item: { minHeight: 54, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center' },
  label: { fontSize: 17 },
  cancel: { justifyContent: 'center' },
  cancelLabel: { fontWeight: '600' },
})
