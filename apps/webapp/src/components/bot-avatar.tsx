import type { BotInfo } from '@openbot/api-contract'
import { useId } from 'react'

type Shape = BotInfo['avatarShape']
type Color = BotInfo['avatarColor']

/** Our own persona marks: a shape on a light-to-dark diagonal gradient, with a face. */
const shapes: Record<Shape, string> = {
  blob: 'M52 5C78 7 95 25 93 52C91 79 72 95 47 94C21 93 5 75 6 49C7 22 26 3 52 5Z',
  pebble: 'M50 12C78 12 96 28 96 52C96 76 76 90 50 90C24 90 4 76 4 52C4 28 22 12 50 12Z',
  squircle: 'M50 6C86 6 94 14 94 50C94 86 86 94 50 94C14 94 6 86 6 50C6 14 14 6 50 6Z',
  tablet: 'M34 4H66C76 4 82 10 82 20V80C82 90 76 96 66 96H34C24 96 18 90 18 80V20C18 10 24 4 34 4Z',
  wedge: 'M44 10C47 5 53 5 56 10L94 82C97 88 93 94 86 94H14C7 94 3 88 6 82Z',
  hex: 'M45 6C48 4 52 4 55 6L89 25C92 27 94 30 94 34V66C94 70 92 73 89 75L55 94C52 96 48 96 45 94L11 75C8 73 6 70 6 66V34C6 30 8 27 11 25Z',
  cloud: 'M28 84C14 84 5 74 5 62C5 50 14 42 25 42C27 26 38 15 53 15C68 15 79 25 81 40C90 42 96 51 96 61C96 74 86 84 74 84Z',
  teardrop: 'M50 4C50 4 88 42 88 63C88 82 71 96 50 96C29 96 12 82 12 63C12 42 50 4 50 4Z',
}

export const avatarPalette: Record<Color, [light: string, dark: string]> = {
  black: ['#4a4a4a', '#141414'],
  brown: ['#b0805a', '#7b5236'],
  red: ['#ff5a5f', '#e0283a'],
  orange: ['#ffa24d', '#f07a0e'],
  yellow: ['#ffd43b', '#e5a800'],
  green: ['#34d399', '#0e9f6e'],
  cyan: ['#22d3ee', '#0891b2'],
  blue: ['#2a92fe', '#0e74e0'],
  violet: ['#a78bfa', '#7c3aed'],
  magenta: ['#f472b6', '#db2777'],
  gray: ['#a3a3a3', '#737373'],
}

export function BotAvatar({
  shape,
  color,
  size = 28,
  working = false,
}: {
  shape: Shape
  color: Color
  size?: number
  /** Shows the green working dot in the corner. */
  working?: boolean
}) {
  const gradient = useId()
  const [light, dark] = avatarPalette[color]
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={light} />
            <stop offset="1" stopColor={dark} />
          </linearGradient>
        </defs>
        <path d={shapes[shape]} fill={`url(#${gradient})`} />
        <circle cx="38" cy="54" r="7" fill="#fcfcfc" />
        <circle cx="62" cy="54" r="7" fill="#fcfcfc" />
        <circle cx="39" cy="55" r="3.5" fill="#141414" />
        <circle cx="63" cy="55" r="3.5" fill="#141414" />
        <path d="M43 70Q50 76 57 70" stroke="#141414" strokeWidth="3" strokeLinecap="round" fill="none" />
      </svg>
      {working && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar bg-status-working motion-safe:animate-pop-in motion-reduce:animate-fade-in" />
      )}
    </span>
  )
}

/** Grok's group avatar: a mosaic of up to four members' marks, with "+N" when there are more. */
export function GroupAvatar({ members, size = 28, working = false }: { members: readonly BotInfo[]; size?: number; working?: boolean }) {
  const shown = members.slice(0, members.length > 4 ? 3 : 4)
  const more = members.length - shown.length
  const cell = shown.length <= 1 ? size : Math.floor(size / 2)
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span className="grid size-full grid-cols-2 place-content-center place-items-center" aria-hidden>
        {shown.map((bot) => (
          <BotAvatar key={bot.id} shape={bot.avatarShape} color={bot.avatarColor} size={cell} />
        ))}
        {more > 0 && <span className="text-[9px] font-semibold text-muted-foreground tabular-nums">+{more}</span>}
      </span>
      {working && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar bg-status-working motion-safe:animate-pop-in motion-reduce:animate-fade-in" />
      )}
    </span>
  )
}
