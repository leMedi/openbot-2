import { avatarShapes, type BotInfo } from '@openbot/api-contract'
import { type CSSProperties, type ReactNode, useId } from 'react'

type Style = BotInfo['avatarStyle']
type Shape = BotInfo['avatarShape']
type Color = BotInfo['avatarColor']
/** What the avatar shows: at rest, busy on a run, or waiting for the owner. */
type AvatarState = 'idle' | 'working' | 'waiting'

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
const INK = '#141414'
const PAPER = '#f4efe6'
const AMBER = '#f59e0b'

/** The traits a shape and colour don't pick come from a seeded random stream, so a bot always looks the same. */
function seeded(key: string) {
  let seed = 2166136261
  for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 16777619)
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(random: () => number, list: readonly T[]) => list[Math.floor(random() * list.length)] as T
/** Starts each avatar's blink somewhere else in its cycle, so a roster doesn't blink in unison. */
const blinkDelay = (random: () => number): CSSProperties => ({ animationDelay: `${(-random() * 6).toFixed(2)}s` })

function mix(a: string, b: string, t: number) {
  const parse = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const [x, y] = [parse(a), parse(b)]
  return `#${x.map((v, i) => Math.round(v + ((y[i] as number) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

type MarkProps = { shape: Shape; color: Color; state: AvatarState; size: number }

// Critter: one body, and the shape picks its accessory, so critters are told apart by silhouette.

const BEAN = 'M50 22C74 22 87 40 87 61C87 81 71 91 50 91C29 91 13 81 13 61C13 40 26 22 50 22Z'

function accessory(index: number, light: string, dark: string, moving: boolean): ReactNode {
  const motion = (name: string) => (moving ? name : undefined)
  switch (index) {
    case 0: // antenna
      return (
        <>
          <path d="M50 24V10" stroke={dark} strokeWidth="3.5" strokeLinecap="round" />
          <circle className={motion('avatar-flash')} cx="50" cy="8" r="6" fill={light} stroke={dark} strokeWidth="2" />
        </>
      )
    case 1: // sprout
      return (
        <g className={motion('avatar-sway')}>
          <path d="M50 26Q49 16 50 10" stroke={dark} strokeWidth="3" strokeLinecap="round" fill="none" />
          <path d="M50 13Q39 1 29 8Q39 17 50 13Z" fill={light} stroke={dark} strokeWidth="1.5" />
          <path d="M50 15Q59 5 68 10Q59 18 50 15Z" fill={light} stroke={dark} strokeWidth="1.5" />
        </g>
      )
    case 2: // cat ears
      return (
        <>
          <path d="M20 44L22 12L46 27Z" fill={dark} />
          <path d="M80 44L78 12L54 27Z" fill={dark} />
        </>
      )
    case 3: // horns
      return (
        <>
          <path d="M31 31Q16 24 20 6Q28 21 41 25Z" fill={PAPER} stroke={mix(dark, INK, 0.3)} strokeWidth="1.5" />
          <path d="M69 31Q84 24 80 6Q72 21 59 25Z" fill={PAPER} stroke={mix(dark, INK, 0.3)} strokeWidth="1.5" />
        </>
      )
    case 4: // tuft
      return <path className={motion('avatar-sway')} d="M40 26Q37 10 47 5Q45 16 51 23Q53 9 64 7Q56 17 60 27Z" fill={dark} />
    case 5: // propeller cap
      return (
        <>
          <path d="M50 18V10" stroke={dark} strokeWidth="3" />
          <ellipse className={motion('avatar-propeller')} cx="50" cy="9" rx="18" ry="3.6" fill={light} stroke={dark} strokeWidth="1.5" />
          <path d="M36 26Q50 12 64 26Z" fill={dark} />
        </>
      )
    case 6: // halo
      return <ellipse className={motion('avatar-float')} cx="50" cy="10" rx="19" ry="5" fill="none" stroke="#fbbf24" strokeWidth="4" />
    default: // bunny ears
      return (
        <>
          <ellipse cx="35" cy="18" rx="7.5" ry="17" transform="rotate(-14 35 18)" fill={dark} />
          <ellipse cx="65" cy="18" rx="7.5" ry="17" transform="rotate(14 65 18)" fill={dark} />
        </>
      )
  }
}

function CritterMark({ shape, color, state, size }: MarkProps) {
  const id = useId()
  const random = seeded(`critter:${shape}:${color}`)
  const [light, dark] = avatarPalette[color]
  const eyes = state === 'waiting' ? 'wide' : pick(random, ['dots', 'ovals', 'happy', 'wide'] as const)
  const mouth = state === 'waiting' ? 'o' : pick(random, ['smile', 'flat', 'o', 'cat', 'none'] as const)
  const cheeks = color !== 'red' && color !== 'magenta' && random() < 0.55
  const blink = blinkDelay(random)
  const detail = size >= 28
  const eye = (x: number) => {
    if (eyes === 'happy') return <path d={`M${x - 6} 58Q${x} 50 ${x + 6} 58`} stroke={INK} strokeWidth="3.5" strokeLinecap="round" fill="none" />
    if (eyes === 'dots')
      return (
        <>
          <circle cx={x} cy="56" r="5.2" fill={INK} />
          <circle cx={x - 1.6} cy="54.4" r="1.6" fill="#fff" />
        </>
      )
    const wide = eyes === 'wide'
    return (
      <>
        <ellipse cx={x} cy="56" rx={wide ? 8 : 6} ry={wide ? 8 : 8.5} fill="#fcfcfc" />
        <circle cx={x + 0.5} cy="57" r={wide ? 4.8 : 3.8} fill={INK} />
        {wide && <circle cx={x - 1.5} cy="55" r="1.6" fill="#fff" />}
      </>
    )
  }
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} overflow="visible" aria-hidden>
      <defs>
        <radialGradient id={id} gradientUnits="userSpaceOnUse" cx="38" cy="36" r="64">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={dark} />
        </radialGradient>
      </defs>
      <g className={state === 'working' ? 'avatar-bob' : state === 'waiting' ? 'avatar-hop' : undefined}>
        {accessory(avatarShapes.indexOf(shape), light, dark, state === 'working')}
        <path d={BEAN} fill={`url(#${id})`} />
        {cheeks && detail && (
          <>
            <ellipse cx="27" cy="68" rx="5.5" ry="3.2" fill="#ff7a9a" opacity=".45" />
            <ellipse cx="73" cy="68" rx="5.5" ry="3.2" fill="#ff7a9a" opacity=".45" />
          </>
        )}
        <g className={state === 'idle' ? 'avatar-blink' : undefined} style={blink}>
          {eye(38)}
          {eye(62)}
        </g>
        {detail && mouth === 'smile' && <path d="M44 70Q50 76 56 70" stroke={INK} strokeWidth="3" strokeLinecap="round" fill="none" />}
        {detail && mouth === 'flat' && <path d="M45 72H55" stroke={INK} strokeWidth="3" strokeLinecap="round" />}
        {detail && mouth === 'o' && <ellipse cx="50" cy="72" rx="3.2" ry="3.8" fill={INK} />}
        {detail && mouth === 'cat' && <path d="M43 70Q46.5 74 50 70Q53.5 74 57 70" stroke={INK} strokeWidth="2.6" strokeLinecap="round" fill="none" />}
      </g>
      {state === 'waiting' && (
        <g className="avatar-flash">
          <circle cx="84" cy="22" r="12" fill={AMBER} />
          <path d="M84 15V24" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
          <circle cx="84" cy="29.5" r="2.3" fill="#fff" />
        </g>
      )}
    </svg>
  )
}

// Bauhaus: a 2×2 poster of quarter circles, halves and triangles in the bot's colour, paper and ink, with eyes on top.
// The shape picks the tile layout.

type Tile = 'quarter' | 'half' | 'circle' | 'tri' | 'solid'
const bauhausLayouts: Tile[][] = [
  ['quarter', 'quarter', 'half', 'half'],
  ['circle', 'tri', 'tri', 'circle'],
  ['half', 'half', 'quarter', 'quarter'],
  ['tri', 'quarter', 'circle', 'solid'],
  ['quarter', 'circle', 'solid', 'tri'],
  ['circle', 'circle', 'half', 'half'],
  ['half', 'tri', 'quarter', 'circle'],
  ['tri', 'tri', 'half', 'quarter'],
]

function tileFigure(tile: Tile, fill: string) {
  if (tile === 'quarter') return <path d="M0 0H42A42 42 0 0 1 0 42Z" fill={fill} />
  if (tile === 'half') return <path d="M0 42A21 21 0 0 1 42 42Z" fill={fill} />
  if (tile === 'circle') return <circle cx="21" cy="21" r="15" fill={fill} />
  if (tile === 'tri') return <path d="M0 0H42L0 42Z" fill={fill} />
  return null
}

function BauhausMark({ shape, color, state, size }: MarkProps) {
  const id = useId()
  const random = seeded(`bauhaus:${shape}:${color}`)
  const [light, dark] = avatarPalette[color]
  const tones = [light, dark, PAPER, INK]
  const tiles = (bauhausLayouts[avatarShapes.indexOf(shape)] as Tile[]).map((tile, i) => {
    // Two corners always wear the bot's colour, so the poster reads as that colour at a glance.
    const background = i === 0 || i === 3 ? pick(random, [light, dark]) : pick(random, [light, dark, PAPER])
    const figure = pick(
      random,
      tones.filter((tone) => tone !== background),
    )
    return { tile, background, figure, turn: Math.floor(random() * 4) }
  })
  const moving = Math.floor(random() * 4)
  const cyclops = random() < 0.2
  const eyeY = 34 + random() * 14
  const spread = 12 + random() * 5
  const blink = blinkDelay(random)
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} overflow="visible" aria-hidden>
      <defs>
        <clipPath id={id}>
          <rect x="8" y="8" width="84" height="84" rx="20" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`}>
        {tiles.map((t, i) => (
          <g key={i} transform={`translate(${8 + (i % 2) * 42} ${8 + Math.floor(i / 2) * 42})`}>
            <g className={state === 'working' && i === moving ? 'avatar-turn' : undefined}>
              {state === 'waiting' && i === moving ? (
                <rect className="avatar-flash" width="42" height="42" fill={AMBER} />
              ) : (
                <rect width="42" height="42" fill={t.background} />
              )}
              <g transform={`rotate(${t.turn * 90} 21 21)`}>{tileFigure(t.tile, t.figure)}</g>
            </g>
          </g>
        ))}
      </g>
      {(cyclops ? [50] : [50 - spread, 50 + spread]).map((x) => (
        <g key={x} className={state === 'idle' ? 'avatar-blink' : undefined} style={blink}>
          <circle cx={x} cy={eyeY} r={cyclops ? 11 : 8.5} fill="#fcfcfc" stroke={INK} strokeWidth="2.5" />
          <circle cx={x} cy={eyeY} r={state === 'waiting' ? 3 : cyclops ? 5.5 : 4.5} fill={INK} />
        </g>
      ))}
    </svg>
  )
}

const marks: Record<Style, (props: MarkProps) => ReactNode> = { critter: CritterMark, bauhaus: BauhausMark }

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
  style: Style
  shape: Shape
  color: Color
  size?: number
  /** Shows the green working dot in the corner, and moves the avatar. */
  working?: boolean
  /** The bot waits for the owner (a question, a hand-off). */
  waiting?: boolean
}) {
  const Mark = marks[style]
  return (
    <span className={`avatar relative inline-flex shrink-0 ${size < 24 ? 'avatar-still' : ''}`} style={{ width: size, height: size }}>
      <Mark shape={shape} color={color} size={size} state={waiting ? 'waiting' : working ? 'working' : 'idle'} />
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
