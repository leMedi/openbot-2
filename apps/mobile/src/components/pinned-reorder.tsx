import * as Haptics from 'expo-haptics'
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, View } from 'react-native'
import { useColors } from '../lib/theme.ts'
import { rowHeight } from './chat-row.tsx'
import { HandleIcon } from './icons.tsx'

/** Where the dragged row is: its index, and the index it would drop at. */
type Drag = { from: number; to: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** `ids` with the one at `from` moved to `to`. */
function moved(ids: readonly string[], from: number, to: number): string[] {
  const order = [...ids]
  order.splice(to, 0, order.splice(from, 1)[0]!)
  return order
}

/**
 * The pinned chats in Edit mode, reordered by dragging a row's handle: the row follows the finger, the others make
 * room, and letting go saves the new order with `onReorder`. `onDragging` tells the list to stop scrolling meanwhile.
 */
export function PinnedReorder({
  ids,
  renderRow,
  onReorder,
  onDragging,
}: {
  ids: readonly string[]
  /** A row, given its handle to show on the right. */
  renderRow: (id: string, handle: ReactNode) => ReactNode
  onReorder: (ids: string[]) => void
  onDragging: (dragging: boolean) => void
}) {
  const [drag, setDrag] = useState<Drag>()
  const [offset] = useState(() => new Animated.Value(0))
  // The handles' touch handlers are made once per handle, so they read the latest props from here, and keep the drag
  // here too: a re-render mid-gesture must not give them new handlers, which would lose the gesture.
  const latest = useRef({ ids, onReorder, onDragging })
  useLayoutEffect(() => {
    latest.current = { ids, onReorder, onDragging }
  })
  const dragging = useRef<Drag>(undefined)
  const target = (from: number, dy: number) => clamp(from + Math.round(dy / rowHeight), 0, latest.current.ids.length - 1)

  const start = useCallback(
    (from: number) => {
      offset.setValue(0)
      dragging.current = { from, to: from }
      setDrag(dragging.current)
      latest.current.onDragging(true)
      void Haptics.selectionAsync()
    },
    [offset],
  )
  const move = useCallback(
    (dy: number) => {
      offset.setValue(dy)
      const current = dragging.current
      if (!current) return
      const to = target(current.from, dy)
      if (to === current.to) return
      void Haptics.selectionAsync()
      dragging.current = { ...current, to }
      setDrag(dragging.current)
    },
    [offset],
  )
  const end = useCallback(
    (dy: number | undefined) => {
      const current = dragging.current
      dragging.current = undefined
      setDrag(undefined)
      offset.setValue(0)
      latest.current.onDragging(false)
      if (!current || dy === undefined) return
      const to = target(current.from, dy)
      if (to !== current.from) latest.current.onReorder(moved(latest.current.ids, current.from, to))
    },
    [offset],
  )
  /** Moves a row one place, for VoiceOver and TalkBack's adjust actions. */
  const step = (from: number, delta: number) => {
    const to = from + delta
    if (to >= 0 && to < ids.length) onReorder(moved(ids, from, to))
  }

  return (
    <View>
      {ids.map((id, index) => {
        const isDragged = drag?.from === index
        // The rows between where the dragged one was and where it would land move one place to make room.
        const shift = !drag || isDragged ? 0 : drag.from < index && index <= drag.to ? -rowHeight : drag.to <= index && index < drag.from ? rowHeight : 0
        return (
          <Animated.View
            key={id}
            style={{ transform: [{ translateY: isDragged ? offset : shift }], zIndex: isDragged ? 1 : 0, elevation: isDragged ? 4 : 0 }}
          >
            {renderRow(id, <Handle index={index} onStart={start} onMove={move} onEnd={end} onStep={step} />)}
          </Animated.View>
        )
      })}
    </View>
  )
}

/** The reorder handle: it takes the touch at once and keeps it, so the list doesn't scroll instead. */
function Handle({
  index,
  onStart,
  onMove,
  onEnd,
  onStep,
}: {
  index: number
  onStart: (index: number) => void
  onMove: (dy: number) => void
  onEnd: (dy: number | undefined) => void
  onStep: (index: number, delta: number) => void
}) {
  const colors = useColors()
  // `index` only changes once a drag has ended, and the callbacks never, so a gesture keeps its handlers.
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => onStart(index),
        onPanResponderMove: (_, gesture) => onMove(gesture.dy),
        onPanResponderRelease: (_, gesture) => onEnd(gesture.dy),
        onPanResponderTerminate: () => onEnd(undefined),
      }),
    [index, onStart, onMove, onEnd],
  )
  return (
    <View
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Reorder"
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => onStep(index, event.nativeEvent.actionName === 'increment' ? 1 : -1)}
      hitSlop={8}
      style={{ alignSelf: 'stretch', justifyContent: 'center', paddingLeft: 12 }}
    >
      <HandleIcon color={colors.faint} />
    </View>
  )
}
