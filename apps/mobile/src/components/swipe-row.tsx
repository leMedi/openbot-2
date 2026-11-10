import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { useColors } from '../lib/theme.ts'

/** How wide the action behind a row is once revealed. */
const actionWidth = 92

/**
 * A row that swipes left to reveal a destructive action behind it, as iOS's lists do (forget a memory note, revoke an
 * account, remove a member): a short swipe reveals it, a long one runs it at once, a tap on the row closes it. Built on
 * React Native's PanResponder, so it needs no native gesture library. Screen readers get the action as a custom action.
 */
export function SwipeRow({ label, onAction, disabled = false, children }: { label: string; onAction: () => void; disabled?: boolean; children: ReactNode }) {
  const colors = useColors()
  const [offset] = useState(() => new Animated.Value(0))
  // Whether the action shows: here for the gesture's handlers, and drawn for the shield over the row.
  const open = useRef(false)
  const [shown, setShown] = useState(false)
  // The gesture's handlers are made once; they read the latest action from here.
  const latest = useRef(onAction)
  useLayoutEffect(() => {
    latest.current = onAction
  })

  const settle = useCallback(
    (to: number) => {
      open.current = to !== 0
      setShown(to !== 0)
      Animated.spring(offset, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 20 }).start()
    },
    [offset],
  )
  const run = useCallback(() => {
    settle(0)
    latest.current()
  }, [settle])

  // Only a clearly sideways drag is the row's; a vertical one scrolls the list.
  const claims = useCallback((dx: number, dy: number) => Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.5 && (dx < 0 || open.current), [])
  /** How far left the row is, `dx` into a drag. */
  const shifted = useCallback((dx: number) => Math.min(0, dx + (open.current ? -actionWidth : 0)), [])
  const release = useCallback(
    (dx: number, vx: number) => {
      const travelled = -shifted(dx)
      if (travelled > actionWidth * 2.4) return run()
      settle(travelled > actionWidth / 2 || vx < -0.5 ? -actionWidth : 0)
    },
    [shifted, run, settle],
  )
  const cancel = useCallback(() => settle(open.current ? -actionWidth : 0), [settle])
  if (disabled) return <>{children}</>
  return (
    <View
      accessibilityActions={[{ name: 'swipeAction', label }]}
      onAccessibilityAction={(event) => event.nativeEvent.actionName === 'swipeAction' && onAction()}
      style={styles.wrap}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        importantForAccessibility="no"
        onPress={run}
        style={[styles.action, { backgroundColor: colors.destructive }]}
      >
        <Text style={[styles.actionLabel, { color: colors.onColor }]}>{label}</Text>
      </Pressable>
      <Surface offset={offset} claims={claims} shifted={shifted} release={release} cancel={cancel}>
        {children}
        {/* While the action shows, a tap on the row closes it rather than reaching what's under it. */}
        {shown && <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={() => settle(0)} />}
      </Surface>
    </View>
  )
}

/** The row in front, following the finger; its handlers are made once, so a re-render mid-gesture doesn't lose it. */
function Surface({
  offset,
  claims,
  shifted,
  release,
  cancel,
  children,
}: {
  offset: Animated.Value
  claims: (dx: number, dy: number) => boolean
  shifted: (dx: number) => number
  release: (dx: number, vx: number) => void
  cancel: () => void
  children: ReactNode
}) {
  const colors = useColors()
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, { dx, dy }) => claims(dx, dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, { dx }) => offset.setValue(shifted(dx)),
        onPanResponderRelease: (_, { dx, vx }) => release(dx, vx),
        onPanResponderTerminate: cancel,
      }),
    [offset, claims, shifted, release, cancel],
  )
  return (
    <Animated.View {...responder.panHandlers} style={{ backgroundColor: colors.muted, transform: [{ translateX: offset }] }}>
      {children}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  action: { position: 'absolute', right: 0, top: 0, bottom: 0, width: actionWidth, alignItems: 'center', justifyContent: 'center' },
  actionLabel: { fontSize: 15, fontWeight: '600' },
})
