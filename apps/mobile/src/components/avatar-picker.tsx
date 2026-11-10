import { avatarColors, avatarShapes, avatarStyles, type BotInfo } from '@openbot/api-contract'
import { avatarStyleLabels } from '@openbot/client'
import { avatarPalette } from '@openbot/ui/avatar'
import { Pressable, StyleSheet, View } from 'react-native'
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg'
import { useColors } from '../lib/theme.ts'
import { BotAvatar } from './avatar.tsx'
import { SegmentedRow } from './grouped.tsx'

export type AvatarLook = Pick<BotInfo, 'avatarStyle' | 'avatarShape' | 'avatarColor'>

/**
 * A bot's avatar to pick, as the web's: its style (Critter or Bauhaus), then its shape and color as rows of choices,
 * each drawn as it would look. `onChange` gets the one part that changed.
 */
export function AvatarPicker({ look, onChange }: { look: AvatarLook; onChange: (change: Partial<AvatarLook>) => void }) {
  const colors = useColors()
  return (
    <>
      <SegmentedRow
        label="Style"
        options={avatarStyles.map((style) => ({ value: style, label: avatarStyleLabels[style] }))}
        value={look.avatarStyle}
        onChange={(avatarStyle) => onChange({ avatarStyle })}
      />
      <View accessibilityRole="radiogroup" accessibilityLabel="Shape" style={styles.choices}>
        {avatarShapes.map((shape) => {
          const chosen = shape === look.avatarShape
          return (
            <Pressable
              key={shape}
              accessibilityRole="radio"
              accessibilityLabel={shape}
              accessibilityState={{ checked: chosen }}
              onPress={() => !chosen && onChange({ avatarShape: shape })}
              style={({ pressed }) => [styles.shape, (chosen || pressed) && { backgroundColor: colors.selected }]}
            >
              <BotAvatar bot={{ ...look, avatarShape: shape }} size={30} />
            </Pressable>
          )
        })}
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel="Color" style={styles.choices}>
        {avatarColors.map((color) => {
          const chosen = color === look.avatarColor
          const [from, to] = avatarPalette[color]
          return (
            <Pressable
              key={color}
              accessibilityRole="radio"
              accessibilityLabel={color}
              accessibilityState={{ checked: chosen }}
              hitSlop={4}
              onPress={() => !chosen && onChange({ avatarColor: color })}
              style={[styles.swatch, { borderColor: chosen ? colors.ring : 'transparent' }]}
            >
              <Svg width={24} height={24} viewBox="0 0 24 24">
                <Defs>
                  <LinearGradient id={`swatch-${color}`} x1="0" y1="0" x2="1" y2="1">
                    <Stop offset="0" stopColor={from} />
                    <Stop offset="1" stopColor={to} />
                  </LinearGradient>
                </Defs>
                <Circle cx="12" cy="12" r="12" fill={`url(#swatch-${color})`} />
              </Svg>
            </Pressable>
          )
        })}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 10, paddingVertical: 10 },
  shape: { padding: 3, borderRadius: 8 },
  swatch: { padding: 2, borderRadius: 16, borderWidth: 2 },
})
