import type { BotInfo } from '@openbot/api-contract'
import { type AvatarNode, avatarMark, avatarViewBox } from '@openbot/ui/avatar'
import { type ComponentType, createElement, type ReactNode, useId } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg'
import { useColors } from '../lib/theme.ts'

/** react-native-svg's element for each tag of @openbot/ui's avatar data. */
const elements: Record<AvatarNode['tag'], ComponentType<Record<string, unknown>>> = {
  defs: Defs,
  radialGradient: RadialGradient,
  stop: Stop,
  clipPath: ClipPath,
  g: G,
  path: Path,
  circle: Circle,
  ellipse: Ellipse,
  rect: Rect,
}

/** Draws the avatar data with react-native-svg; the motions aren't played on the phone yet, so the avatar stays still. */
export function draw(node: AvatarNode, key: number): ReactNode {
  return createElement(elements[node.tag], { key, ...node.attrs }, node.children?.map(draw))
}

/** A bot's avatar, as the web draws it, with the green working dot in the corner. */
export function BotAvatar({ bot, size = 44, working = false, waiting = false }: { bot: Pick<BotInfo, 'avatarStyle' | 'avatarShape' | 'avatarColor'>; size?: number; working?: boolean; waiting?: boolean }) {
  // An id unique in the app, for the gradient or clip path the drawing defines; react's ids have colons, which url(#…) refuses.
  const id = `avatar${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const state = waiting ? 'waiting' : working ? 'working' : 'idle'
  return (
    <View style={{ width: size, height: size }}>
      <Svg viewBox={avatarViewBox} width={size} height={size}>
        {avatarMark({ style: bot.avatarStyle, shape: bot.avatarShape, color: bot.avatarColor, state, size, id }).map(draw)}
      </Svg>
      {working && !waiting && <WorkingDot size={size} />}
    </View>
  )
}

/** A group's avatar: a mosaic of up to four members' avatars, with "+N" when there are more. */
export function GroupAvatar({ members, size = 44, working = false }: { members: readonly BotInfo[]; size?: number; working?: boolean }) {
  const colors = useColors()
  const shown = members.slice(0, members.length > 4 ? 3 : 4)
  const more = members.length - shown.length
  const cell = shown.length <= 1 ? size : Math.floor(size / 2)
  return (
    <View style={{ width: size, height: size }}>
      <View style={[styles.mosaic, { width: size, height: size }]}>
        {shown.map((bot) => (
          <BotAvatar key={bot.id} bot={bot} size={cell} />
        ))}
        {more > 0 && (
          <View style={[styles.more, { width: cell, height: cell }]}>
            <Text style={[styles.moreText, { color: colors.mutedForeground }]}>+{more}</Text>
          </View>
        )}
      </View>
      {working && <WorkingDot size={size} />}
    </View>
  )
}

function WorkingDot({ size }: { size: number }) {
  const colors = useColors()
  const dot = Math.max(10, Math.round(size / 4))
  return (
    <View
      style={[styles.dot, { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: colors.statusWorking, borderColor: colors.background }]}
    />
  )
}

const styles = StyleSheet.create({
  mosaic: { flexDirection: 'row', flexWrap: 'wrap', alignContent: 'center', justifyContent: 'center' },
  more: { alignItems: 'center', justifyContent: 'center' },
  moreText: { fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
  dot: { position: 'absolute', right: -1, bottom: -1, borderWidth: 2 },
})
