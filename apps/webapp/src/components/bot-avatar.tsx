import type { BotInfo } from '@openbot/api-contract'
import { type AvatarColor, type AvatarNode, type AvatarShape, type AvatarStyle, avatarMark, avatarViewBox } from '@openbot/ui/avatar'
import { createElement, type ReactNode, useId } from 'react'

/** Draws @openbot/ui's avatar data as DOM SVG; each motion is an `avatar-*` class animated in styles.css. */
function draw(node: AvatarNode, key: number): ReactNode {
  return createElement(
    node.tag,
    {
      key,
      ...node.attrs,
      ...(node.motion && { className: `avatar-${node.motion}` }),
      ...(node.delay !== undefined && { style: { animationDelay: `${node.delay.toFixed(2)}s` } }),
    },
    node.children?.map(draw),
  )
}

/**
 * Our bot avatars: a critter or a Bauhaus poster in the bot's colour, the shape picking its accessory or tile layout.
 * At 24px and up the avatar moves with the bot: it blinks at rest, moves while working (a critter's accessory, one
 * Bauhaus tile turning) and flags when the bot waits for the owner. Smaller avatars and reduced motion stay still.
 */
export function BotAvatar({
  style,
  shape,
  color,
  size = 28,
  working = false,
  waiting = false,
}: {
  style: AvatarStyle
  shape: AvatarShape
  color: AvatarColor
  size?: number
  /** Shows the green working dot in the corner, and moves the avatar. */
  working?: boolean
  /** The bot waits for the owner (a question, a hand-off). */
  waiting?: boolean
}) {
  const id = useId()
  const state = waiting ? 'waiting' : working ? 'working' : 'idle'
  return (
    <span className={`avatar relative inline-flex shrink-0 ${size < 24 ? 'avatar-still' : ''}`} style={{ width: size, height: size }}>
      <svg viewBox={avatarViewBox} width={size} height={size} overflow="visible" aria-hidden>
        {avatarMark({ style, shape, color, state, size, id }).map(draw)}
      </svg>
      {working && !waiting && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar bg-status-working motion-safe:animate-pop-in motion-reduce:animate-fade-in" />
      )}
    </span>
  )
}

/** A group's avatar: a mosaic of up to four members' avatars, with "+N" when there are more. */
export function GroupAvatar({ members, size = 28, working = false }: { members: readonly BotInfo[]; size?: number; working?: boolean }) {
  const shown = members.slice(0, members.length > 4 ? 3 : 4)
  const more = members.length - shown.length
  const cell = shown.length <= 1 ? size : Math.floor(size / 2)
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span className="grid size-full grid-cols-2 place-content-center place-items-center" aria-hidden>
        {shown.map((bot) => (
          <BotAvatar key={bot.id} style={bot.avatarStyle} shape={bot.avatarShape} color={bot.avatarColor} size={cell} />
        ))}
        {more > 0 && <span className="text-[9px] font-semibold text-muted-foreground tabular-nums">+{more}</span>}
      </span>
      {working && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar bg-status-working motion-safe:animate-pop-in motion-reduce:animate-fade-in" />
      )}
    </span>
  )
}
