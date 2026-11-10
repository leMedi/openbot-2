import type { PluginInfo } from '@openbot/api-contract'
import { useEffect, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { useInstance } from '../lib/instance-context.ts'
import { useColors } from '../lib/theme.ts'

type Icon = { kind: 'svg'; xml: string } | { kind: 'image'; uri: string } | { kind: 'none' }

/** Icons fetched this run, by URL: most are SVG, which Image can't draw, so each is fetched once to tell. */
const icons = new Map<string, Promise<Icon>>()

function loadIcon(uri: string): Promise<Icon> {
  let icon = icons.get(uri)
  if (!icon) {
    icon = fetch(uri)
      .then(async (response): Promise<Icon> => {
        if (!response.ok) return { kind: 'none' }
        if (response.headers.get('content-type')?.includes('svg')) return { kind: 'svg', xml: await response.text() }
        return { kind: 'image', uri }
      })
      .catch((): Icon => {
        // Tried again next time.
        icons.delete(uri)
        return { kind: 'none' }
      })
    icons.set(uri, icon)
  }
  return icon
}

/** A plugin's icon from the instance, or its name's first letter when it has none (or until it loads). */
export function PluginIcon({ plugin, size = 32 }: { plugin: PluginInfo; size?: number }) {
  const { url } = useInstance()
  const colors = useColors()
  const uri = plugin.icon && new URL(`/api${plugin.icon}`, url).href
  const [icon, setIcon] = useState<Icon>({ kind: 'none' })
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!uri) return
    let current = true
    void loadIcon(uri).then((loaded) => current && setIcon(loaded))
    return () => void (current = false)
  }, [uri])

  const box = { width: size, height: size, borderRadius: size * 0.22 }
  if (icon.kind === 'svg' && !failed) {
    return (
      <View style={[styles.box, box]}>
        <SvgXml xml={icon.xml} width={size} height={size} onError={() => setFailed(true)} />
      </View>
    )
  }
  if (icon.kind === 'image' && !failed) return <Image source={{ uri: icon.uri }} style={box} onError={() => setFailed(true)} />
  return (
    <View style={[styles.box, box, { backgroundColor: colors.secondary }]}>
      <Text style={[styles.letter, { color: colors.mutedForeground, fontSize: size * 0.45 }]}>{plugin.displayName.charAt(0).toUpperCase()}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { fontWeight: '600' },
})
