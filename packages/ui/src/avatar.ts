import { avatarShapes, type BotInfo } from '@openbot/api-contract'

/**
 * Our bot avatars as data: a critter or a Bauhaus poster in the bot's colour, the shape picking its accessory or tile
 * layout. avatarMark describes the drawing as a tree of SVG elements whose attributes use React's names, which the web
 * renders with DOM SVG and the phone with react-native-svg, so both draw the same avatar. Nothing here touches the DOM.
 */

export type AvatarStyle = BotInfo['avatarStyle']
export type AvatarShape = BotInfo['avatarShape']
export type AvatarColor = BotInfo['avatarColor']
/** What the avatar shows: at rest, busy on a run, or waiting for the owner. */
export type AvatarState = 'idle' | 'working' | 'waiting'

/** Each colour's light and dark tone; avatars shade between them. */
export const avatarPalette: Record<AvatarColor, [light: string, dark: string]> = {
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

/**
 * How a part moves (while the app animates it). Each part turns about its own box; sway turns about its bottom edge.
 * blink: scaleY to 0.1 near the end of a 6s cycle · flash: opacity pulse, 1.1s · turn: a quarter turn at a time, 3.2s ·
 * bob: up 4px, 0.7s · hop: two hops then rest, 1.6s · sway: a few degrees side to side, 1.2s · propeller: spins, 0.35s ·
 * float: up and down, 1.4s. The web's keyframes are in the webapp's styles.css.
 */
export type AvatarMotion = 'blink' | 'flash' | 'turn' | 'bob' | 'hop' | 'sway' | 'propeller' | 'float'

export type AvatarNode = {
  tag: 'defs' | 'radialGradient' | 'stop' | 'clipPath' | 'g' | 'path' | 'circle' | 'ellipse' | 'rect'
  /** SVG attributes under React's names (strokeWidth, stopColor, clipPath…), shared by DOM SVG and react-native-svg. */
  attrs: Record<string, string | number>
  motion?: AvatarMotion
  /** Seconds into its cycle the motion starts at (negative), so a roster doesn't blink in unison. */
  delay?: number
  children?: AvatarNode[]
}

/** Every avatar is drawn in this box; parts may spill a little outside it (overflow visible). */
export const avatarViewBox = '0 0 100 100'

const el = (tag: AvatarNode['tag'], attrs: AvatarNode['attrs'], children?: AvatarNode[], motion?: AvatarMotion): AvatarNode => ({
  tag,
  attrs,
  ...(children && { children }),
  ...(motion && { motion }),
})

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
const pick = <T>(random: () => number, list: readonly T[]) => list[Math.floor(random() * list.length)] as T
const blinkDelay = (random: () => number) => -random() * 6

function mix(a: string, b: string, t: number) {
  const parse = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const [x, y] = [parse(a), parse(b)]
  return `#${x.map((v, i) => Math.round(v + ((y[i] as number) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

export type AvatarMarkOptions = {
  style: AvatarStyle
  shape: AvatarShape
  color: AvatarColor
  state: AvatarState
  /** Drawn size in px: under 28 a critter drops its cheeks and mouth. */
  size: number
  /** A document-unique id for the gradient or clip path the drawing defines and refers to. */
  id: string
}

/** The avatar's drawing: the children of an svg with avatarViewBox and overflow visible. */
export function avatarMark(options: AvatarMarkOptions): AvatarNode[] {
  return marks[options.style](options)
}

// Critter: one body, and the shape picks its accessory, so critters are told apart by silhouette.

const BEAN = 'M50 22C74 22 87 40 87 61C87 81 71 91 50 91C29 91 13 81 13 61C13 40 26 22 50 22Z'

function accessory(index: number, light: string, dark: string, moving: boolean): AvatarNode[] {
  const motion = (name: AvatarMotion) => (moving ? name : undefined)
  switch (index) {
    case 0: // antenna
      return [
        el('path', { d: 'M50 24V10', stroke: dark, strokeWidth: '3.5', strokeLinecap: 'round' }),
        el('circle', { cx: '50', cy: '8', r: '6', fill: light, stroke: dark, strokeWidth: '2' }, undefined, motion('flash')),
      ]
    case 1: // sprout
      return [
        el(
          'g',
          {},
          [
            el('path', { d: 'M50 26Q49 16 50 10', stroke: dark, strokeWidth: '3', strokeLinecap: 'round', fill: 'none' }),
            el('path', { d: 'M50 13Q39 1 29 8Q39 17 50 13Z', fill: light, stroke: dark, strokeWidth: '1.5' }),
            el('path', { d: 'M50 15Q59 5 68 10Q59 18 50 15Z', fill: light, stroke: dark, strokeWidth: '1.5' }),
          ],
          motion('sway'),
        ),
      ]
    case 2: // cat ears
      return [el('path', { d: 'M20 44L22 12L46 27Z', fill: dark }), el('path', { d: 'M80 44L78 12L54 27Z', fill: dark })]
    case 3: // horns
      return [
        el('path', { d: 'M31 31Q16 24 20 6Q28 21 41 25Z', fill: PAPER, stroke: mix(dark, INK, 0.3), strokeWidth: '1.5' }),
        el('path', { d: 'M69 31Q84 24 80 6Q72 21 59 25Z', fill: PAPER, stroke: mix(dark, INK, 0.3), strokeWidth: '1.5' }),
      ]
    case 4: // tuft
      return [el('path', { d: 'M40 26Q37 10 47 5Q45 16 51 23Q53 9 64 7Q56 17 60 27Z', fill: dark }, undefined, motion('sway'))]
    case 5: // propeller cap
      return [
        el('path', { d: 'M50 18V10', stroke: dark, strokeWidth: '3' }),
        el('ellipse', { cx: '50', cy: '9', rx: '18', ry: '3.6', fill: light, stroke: dark, strokeWidth: '1.5' }, undefined, motion('propeller')),
        el('path', { d: 'M36 26Q50 12 64 26Z', fill: dark }),
      ]
    case 6: // halo
      return [el('ellipse', { cx: '50', cy: '10', rx: '19', ry: '5', fill: 'none', stroke: '#fbbf24', strokeWidth: '4' }, undefined, motion('float'))]
    default: // bunny ears
      return [
        el('ellipse', { cx: '35', cy: '18', rx: '7.5', ry: '17', transform: 'rotate(-14 35 18)', fill: dark }),
        el('ellipse', { cx: '65', cy: '18', rx: '7.5', ry: '17', transform: 'rotate(14 65 18)', fill: dark }),
      ]
  }
}

function critterMark({ shape, color, state, size, id }: AvatarMarkOptions): AvatarNode[] {
  const random = seeded(`critter:${shape}:${color}`)
  const [light, dark] = avatarPalette[color]
  const eyes = state === 'waiting' ? 'wide' : pick(random, ['dots', 'ovals', 'happy', 'wide'] as const)
  const mouth = state === 'waiting' ? 'o' : pick(random, ['smile', 'flat', 'o', 'cat', 'none'] as const)
  const cheeks = color !== 'red' && color !== 'magenta' && random() < 0.55
  const delay = blinkDelay(random)
  const detail = size >= 28
  const eye = (x: number): AvatarNode[] => {
    if (eyes === 'happy')
      return [el('path', { d: `M${x - 6} 58Q${x} 50 ${x + 6} 58`, stroke: INK, strokeWidth: '3.5', strokeLinecap: 'round', fill: 'none' })]
    if (eyes === 'dots') return [el('circle', { cx: x, cy: '56', r: '5.2', fill: INK }), el('circle', { cx: x - 1.6, cy: '54.4', r: '1.6', fill: '#fff' })]
    const wide = eyes === 'wide'
    return [
      el('ellipse', { cx: x, cy: '56', rx: wide ? 8 : 6, ry: wide ? 8 : 8.5, fill: '#fcfcfc' }),
      el('circle', { cx: x + 0.5, cy: '57', r: wide ? 4.8 : 3.8, fill: INK }),
      ...(wide ? [el('circle', { cx: x - 1.5, cy: '55', r: '1.6', fill: '#fff' })] : []),
    ]
  }
  const mouths: Record<typeof mouth, AvatarNode[]> = {
    smile: [el('path', { d: 'M44 70Q50 76 56 70', stroke: INK, strokeWidth: '3', strokeLinecap: 'round', fill: 'none' })],
    flat: [el('path', { d: 'M45 72H55', stroke: INK, strokeWidth: '3', strokeLinecap: 'round' })],
    o: [el('ellipse', { cx: '50', cy: '72', rx: '3.2', ry: '3.8', fill: INK })],
    cat: [el('path', { d: 'M43 70Q46.5 74 50 70Q53.5 74 57 70', stroke: INK, strokeWidth: '2.6', strokeLinecap: 'round', fill: 'none' })],
    none: [],
  }
  return [
    el('defs', {}, [
      el('radialGradient', { id, gradientUnits: 'userSpaceOnUse', cx: '38', cy: '36', r: '64' }, [
        el('stop', { offset: '0', stopColor: light }),
        el('stop', { offset: '1', stopColor: dark }),
      ]),
    ]),
    el(
      'g',
      {},
      [
        ...accessory(avatarShapes.indexOf(shape), light, dark, state === 'working'),
        el('path', { d: BEAN, fill: `url(#${id})` }),
        ...(cheeks && detail
          ? [
              el('ellipse', { cx: '27', cy: '68', rx: '5.5', ry: '3.2', fill: '#ff7a9a', opacity: '.45' }),
              el('ellipse', { cx: '73', cy: '68', rx: '5.5', ry: '3.2', fill: '#ff7a9a', opacity: '.45' }),
            ]
          : []),
        { ...el('g', {}, [...eye(38), ...eye(62)], state === 'idle' ? 'blink' : undefined), delay },
        ...(detail ? mouths[mouth] : []),
      ],
      state === 'working' ? 'bob' : state === 'waiting' ? 'hop' : undefined,
    ),
    ...(state === 'waiting'
      ? [
          el(
            'g',
            {},
            [
              el('circle', { cx: '84', cy: '22', r: '12', fill: AMBER }),
              el('path', { d: 'M84 15V24', stroke: '#fff', strokeWidth: '4', strokeLinecap: 'round' }),
              el('circle', { cx: '84', cy: '29.5', r: '2.3', fill: '#fff' }),
            ],
            'flash',
          ),
        ]
      : []),
  ]
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

function tileFigure(tile: Tile, fill: string): AvatarNode[] {
  if (tile === 'quarter') return [el('path', { d: 'M0 0H42A42 42 0 0 1 0 42Z', fill })]
  if (tile === 'half') return [el('path', { d: 'M0 42A21 21 0 0 1 42 42Z', fill })]
  if (tile === 'circle') return [el('circle', { cx: '21', cy: '21', r: '15', fill })]
  if (tile === 'tri') return [el('path', { d: 'M0 0H42L0 42Z', fill })]
  return []
}

function bauhausMark({ shape, color, state, id }: AvatarMarkOptions): AvatarNode[] {
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
  const delay = blinkDelay(random)
  return [
    el('defs', {}, [el('clipPath', { id }, [el('rect', { x: '8', y: '8', width: '84', height: '84', rx: '20' })])]),
    el(
      'g',
      { clipPath: `url(#${id})` },
      tiles.map((t, i) =>
        el('g', { transform: `translate(${8 + (i % 2) * 42} ${8 + Math.floor(i / 2) * 42})` }, [
          el(
            'g',
            {},
            [
              state === 'waiting' && i === moving
                ? el('rect', { width: '42', height: '42', fill: AMBER }, undefined, 'flash')
                : el('rect', { width: '42', height: '42', fill: t.background }),
              el('g', { transform: `rotate(${t.turn * 90} 21 21)` }, tileFigure(t.tile, t.figure)),
            ],
            state === 'working' && i === moving ? 'turn' : undefined,
          ),
        ]),
      ),
    ),
    ...(cyclops ? [50] : [50 - spread, 50 + spread]).map((x) => ({
      ...el(
        'g',
        {},
        [
          el('circle', { cx: x, cy: eyeY, r: cyclops ? 11 : 8.5, fill: '#fcfcfc', stroke: INK, strokeWidth: '2.5' }),
          el('circle', { cx: x, cy: eyeY, r: state === 'waiting' ? 3 : cyclops ? 5.5 : 4.5, fill: INK }),
        ],
        state === 'idle' ? 'blink' : undefined,
      ),
      delay,
    })),
  ]
}

const marks: Record<AvatarStyle, (options: AvatarMarkOptions) => AvatarNode[]> = { critter: critterMark, bauhaus: bauhausMark }
