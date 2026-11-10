import { Stack } from 'expo-router'
import { useColors } from '../../lib/theme.ts'

/** The New group chat sheet's stack, for its header. */
export default function NewGroupLayout() {
  const colors = useColors()
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerTitleAlign: 'center',
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
        headerTitleStyle: { color: colors.foreground },
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  )
}
