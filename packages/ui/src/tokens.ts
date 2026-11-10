/**
 * Grok Bot's design tokens (docs/grok-bot/05-ui.md §7), the source of truth for both apps: plain values with no CSS or
 * DOM, so the phone styles with them directly. The web's theme.css restates them as CSS variables, and tokens.test.ts
 * fails when the two drift. Colours are hex (#rrggbb, or #rrggbbaa with alpha); sizes are px.
 */

const light = {
  // Surfaces and text
  background: '#fcfcfc',
  foreground: '#141414',
  sidebar: '#f7f7f7',
  sidebarForeground: '#141414',
  card: '#fcfcfc',
  cardForeground: '#141414',
  popover: '#fcfcfc',
  popoverForeground: '#141414',
  scrim: '#14141480',
  scrimHeavy: '#141414e5',
  muted: '#f3f3f3',
  mutedForeground: '#14141499',
  faint: '#14141466',
  disabled: '#1414144d',
  link: '#0c64c1',

  // Fills: primary buttons are black in light mode, white in dark; blue is only for links, focus and unread
  primary: '#070707',
  primaryHover: '#2f2f2f',
  primaryForeground: '#fcfcfc',
  secondary: '#77777717',
  secondaryHover: '#7777772b',
  secondaryForeground: '#141414',
  accent: '#77777717',
  accentForeground: '#141414',
  selected: '#7777772b',
  inputFill: '#fcfcfc',
  destructive: '#ff263c',
  destructiveForeground: '#c21d2e',

  // Borders
  borderSubtle: '#1414140d',
  border: '#1414141a',
  input: '#14141426',
  borderStrong: '#1414144d',
  ring: '#14141466',

  // Chat
  bubbleAgent: '#eeeeee',
  bubbleUser: '#070707',
  onColor: '#fcfcfc',
  controlChecked: '#070707',
  controlTrack: '#1414141a',

  // Status and hues
  blue: '#1084fe',
  blueForeground: '#0c64c1',
  blueSubtle: '#1084fe17',
  green: '#00c972',
  greenForeground: '#009957',
  amber: '#ff9800',
  amberForeground: '#c27400',
  red: '#ff263c',
  redForeground: '#c21d2e',
  purple: '#9159fe',
  purpleForeground: '#6e44c1',
  gray: '#777777',
  statusWorking: '#00c972',
  statusAttention: '#ff9800',
  statusUnread: '#1084fe',
  statusOffline: '#777777',
  statusError: '#ff263c',
}

export type ColorToken = keyof typeof light

const dark: Record<ColorToken, string> = {
  background: '#070707',
  foreground: '#fcfcfc',
  sidebar: '#111111',
  sidebarForeground: '#fcfcfc',
  card: '#181818',
  cardForeground: '#fcfcfc',
  popover: '#181818',
  popoverForeground: '#fcfcfc',
  scrim: '#141414b2',
  scrimHeavy: '#141414f2',
  muted: '#151515',
  mutedForeground: '#fcfcfc99',
  faint: '#fcfcfc66',
  disabled: '#fcfcfc4d',
  link: '#459ffe',

  primary: '#fafafa',
  primaryHover: '#d5d5d5',
  primaryForeground: '#141414',
  secondary: '#7777772c',
  secondaryHover: '#77777752',
  secondaryForeground: '#fcfcfc',
  accent: '#7777772c',
  accentForeground: '#fcfcfc',
  selected: '#77777752',
  inputFill: '#2f2f2f',
  destructive: '#ff263c',
  destructiveForeground: '#ff5667',

  borderSubtle: '#fcfcfc0d',
  border: '#fcfcfc1a',
  input: '#fcfcfc26',
  borderStrong: '#fcfcfc4d',
  ring: '#fcfcfc66',

  bubbleAgent: '#262626',
  bubbleUser: '#5a5a5a',
  onColor: '#fcfcfc',
  controlChecked: '#5a5a5a',
  controlTrack: '#fcfcfc1a',

  blue: '#1084fe',
  blueForeground: '#459ffe',
  blueSubtle: '#1084fe2c',
  green: '#00c972',
  greenForeground: '#38d591',
  amber: '#ff9800',
  amberForeground: '#ffaf38',
  red: '#ff263c',
  redForeground: '#ff5667',
  purple: '#9159fe',
  purpleForeground: '#a97efe',
  gray: '#777777',
  statusWorking: '#00c972',
  statusAttention: '#ff9800',
  statusUnread: '#1084fe',
  statusOffline: '#777777',
  statusError: '#ff263c',
}

/** Each colour in light and dark mode. */
export const colors: { light: Record<ColorToken, string>; dark: Record<ColorToken, string> } = { light, dark }

/** Corner radii in px; lg (10) is the default for cards and controls. */
export const radii = { xs: 2, sm: 4, md: 8, lg: 10, xl: 14, '2xl': 16, '3xl': 18 } as const

/** The type scale in px: 11 / 12 / 13 / 14, with xl for page headings only (large text gets tighter tracking). */
export const text = {
  xs: { fontSize: 11, lineHeight: 14, letterSpacing: 0.07 },
  sm: { fontSize: 12, lineHeight: 16 },
  base: { fontSize: 13, lineHeight: 18, letterSpacing: -0.08 },
  lg: { fontSize: 14, lineHeight: 22, letterSpacing: -0.15 },
  xl: { fontSize: 20, lineHeight: 26, letterSpacing: -0.3 },
} as const
