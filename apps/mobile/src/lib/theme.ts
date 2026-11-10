import { colors, type ColorToken } from '@openbot/ui/tokens'
import { useColorScheme } from 'react-native'

export { radii, text } from '@openbot/ui/tokens'

/** The design tokens' colours for the phone's light or dark scheme. */
export function useColors(): Record<ColorToken, string> {
  return colors[useColorScheme() === 'dark' ? 'dark' : 'light']
}
