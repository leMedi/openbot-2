import { Stack } from 'expo-router'
import { useColors } from '../../lib/theme.ts'

/**
 * The Settings sheet's own stack (spec: Phone screen map): Settings, then General, Models, Plugins → plugin, Shared
 * memory and Edit address pushed within the sheet, so closing it from any screen returns to Chats.
 */
export default function SettingsLayout() {
  const colors = useColors()
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
        headerTitleStyle: { color: colors.foreground },
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  )
}
