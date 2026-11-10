import type { ReactNode } from 'react'
import Svg, { Circle, Path } from 'react-native-svg'

/** A line icon on a 24 or 16 unit grid, in `color`. */
function Icon({ size, color, box = 24, stroke = 1.8, fill = false, children }: { size: number; color: string; box?: number; stroke?: number; fill?: boolean; children: ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      fill={fill ? color : 'none'}
      stroke={fill ? 'none' : color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </Svg>
  )
}

type IconProps = { size?: number; color: string }

export const GearIcon = ({ size = 22, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Circle cx="12" cy="12" r="3" />
    <Path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </Icon>
)

export const PlusIcon = ({ size = 22, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M12 5v14M5 12h14" />
  </Icon>
)

export const PinIcon = ({ size = 12, color }: IconProps) => (
  <Icon size={size} color={color} box={16} fill>
    <Path d="M10.5 1.5 14.5 5.5 12.6 6.2 10.2 8.6 10.6 12 9.5 13.1 6.7 10.3 3 14 2 13 5.7 9.3 2.9 6.5 4 5.4 7.4 5.8 9.8 3.4Z" />
  </Icon>
)

/** A bell struck through: the chat's bots' messages don't notify the phone. */
export const MutedIcon = ({ size = 12, color }: IconProps) => (
  <Icon size={size} color={color} box={16} stroke={1.5}>
    <Path d="M3.5 11.5h9L11 9.5V7a3 3 0 0 0-6 0v2.5Z M6.75 13.5h2.5" />
    <Path d="M2 2 14 14" />
  </Icon>
)

export const CheckIcon = ({ size = 14, color }: IconProps) => (
  <Icon size={size} color={color} stroke={2.6}>
    <Path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
)

/** The reorder handle of a pinned chat in Edit mode. */
export const HandleIcon = ({ size = 22, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M5 8h14M5 12h14M5 16h14" />
  </Icon>
)

export const ChevronIcon = ({ size = 12, color, folded }: IconProps & { folded: boolean }) => (
  <Icon size={size} color={color} box={16} stroke={1.6}>
    <Path d={folded ? 'M6 4l4 4-4 4' : 'M4 6l4 4 4-4'} />
  </Icon>
)

export type HitIconKind = 'message' | 'file' | 'routine'

/** A search hit's icon, as the web palette's. */
export const HitIcon = ({ size = 18, color, kind }: IconProps & { kind: HitIconKind }) => (
  <Icon size={size} color={color} box={16} stroke={1.3}>
    {kind === 'message' ? (
      <Path d="M3 4h10v7H7l-3 2.5V11H3z" />
    ) : kind === 'file' ? (
      <Path d="M4.5 2.5h4.5l3 3v8h-7.5zM9 2.5v3h3" />
    ) : (
      <>
        <Circle cx="8" cy="8" r="5.5" />
        <Path d="M8 5v3l2 1.5" />
      </>
    )}
  </Icon>
)

export const SearchIcon = ({ size = 17, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Circle cx="11" cy="11" r="7" />
    <Path d="M20 20l-4-4" />
  </Icon>
)

export const CloseIcon = ({ size = 14, color }: IconProps) => (
  <Icon size={size} color={color} box={16} stroke={1.75}>
    <Path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
)

/** A routine chip's clock. */
export const ClockIcon = ({ size = 13, color }: IconProps) => (
  <Icon size={size} color={color} box={16} stroke={1.4}>
    <Circle cx="8" cy="8" r="6.25" />
    <Path d="M8 4.75V8l2.25 1.5" />
  </Icon>
)

/** The composer's Send: an arrow up. */
export const SendIcon = ({ size = 18, color }: IconProps) => (
  <Icon size={size} color={color} box={16} stroke={1.9}>
    <Path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </Icon>
)

/** A file chip's page with a folded corner. */
export const FileIcon = ({ size = 18, color }: IconProps) => (
  <Icon size={size} color={color} box={16} stroke={1.4}>
    <Path d="M4 1.75h5.25L12.5 5v9.25H4z" />
    <Path d="M9 1.75V5.25h3.5" />
  </Icon>
)

/** A video or a sound to play. */
export const PlayIcon = ({ size = 18, color }: IconProps) => (
  <Icon size={size} color={color} box={16} fill>
    <Path d="M5 3.2v9.6L12.6 8Z" />
  </Icon>
)

/** The chat header's Screen button: a display. */
export const ScreenIcon = ({ size = 22, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M3.5 5h17v11h-17zM9 20h6M12 16v4" />
  </Icon>
)

/** The bot info screen's Memory button. */
export const MemoryIcon = ({ size = 22, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M12 5a3 3 0 00-5.9.8A3 3 0 004 11a3 3 0 001 5 3 3 0 005 2.5V5zM12 5a3 3 0 015.9.8A3 3 0 0120 11a3 3 0 01-1 5 3 3 0 01-5 2.5" />
  </Icon>
)

/** The bot info screen's Access button: a key. */
export const KeyIcon = ({ size = 22, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Circle cx="8" cy="15" r="4" />
    <Path d="M11 12l9-9M17 6l3 3" />
  </Icon>
)

/** A paused routine. */
export const PauseIcon = ({ size = 16, color }: IconProps) => (
  <Icon size={size} color={color} box={16} stroke={1.4}>
    <Circle cx="8" cy="8" r="6.25" />
    <Path d="M6.5 5.75v4.5M9.5 5.75v4.5" />
  </Icon>
)

/** The Screen's Keyboard: raises the phone's keyboard to type on it. */
export const KeyboardIcon = ({ size = 20, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M3 6.5h18v11H3z" />
    <Path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" />
  </Icon>
)

/** The Screen's Keys: Esc, Tab, Enter, arrows and the modifiers. */
export const KeysIcon = ({ size = 20, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
  </Icon>
)

/** The Screen's Paste: the clipboard. */
export const PasteIcon = ({ size = 20, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M8.5 4.5H6v16h12v-16h-2.5" />
    <Path d="M9 3h6v3H9z" />
  </Icon>
)

/** The Screen's Fit: the whole Screen in view. */
export const FitIcon = ({ size = 20, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
  </Icon>
)

/** The Screen's 1:1: actual size, panned. */
export const ActualSizeIcon = ({ size = 20, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9.5 9.5l5 5M14.5 9.5l-5 5" />
  </Icon>
)

/** The landscape toolbar's tuck: a chevron toward the edge, or back. */
export const TuckIcon = ({ size = 16, color, out }: IconProps & { out: boolean }) => (
  <Icon size={size} color={color} box={16} stroke={1.8}>
    <Path d={out ? 'M10 4 6 8l4 4' : 'M6 4l4 4-4 4'} />
  </Icon>
)

/** The composer's mic: Dictation. */
export const MicIcon = ({ size = 18, color }: IconProps) => (
  <Icon size={size} color={color}>
    <Path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
    <Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Icon>
)
