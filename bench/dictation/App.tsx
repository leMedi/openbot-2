import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef, useState } from 'react'
import { Alert, PermissionsAndroid, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native'
import Bench from './modules/bench-native'
import {
  clearResults,
  clipFile,
  clipMs,
  download,
  ensureDirs,
  isDownloaded,
  loadResults,
  removeDownload,
  report,
  type Result,
  run,
  sample,
  soak,
} from './src/bench'
import { type Asset, assets, variants } from './src/models'
import { type Clip, clips } from './src/passages'

ensureDirs()

const device = Bench.deviceInfo()
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`
const SOAK_MINUTES = 5

// One screen, top to bottom in the order the benchmark is done: record the clips, download the models, run, soak, share.
export default function App() {
  const [, refresh] = useState(0)
  const rerender = () => refresh((n) => n + 1)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [recording, setRecording] = useState<{ clip: string; since: number } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set(variants.map((v) => v.id)))
  const [soakVariant, setSoakVariant] = useState(variants[0].id)
  const [results, setResults] = useState<Result[]>(loadResults)
  const [live, setLive] = useState(sample)
  const tick = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    tick.current = setInterval(() => setLive(sample()), 1000)
    return () => clearInterval(tick.current!)
  }, [])

  const say = (line: string) => setLog((lines) => [...lines.slice(-30), `${new Date().toLocaleTimeString()} ${line}`])

  async function exclusive(label: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(label)
    await activateKeepAwakeAsync('bench')
    try {
      await work()
    } catch (error) {
      say(`${label}: ${String(error)}`)
    } finally {
      deactivateKeepAwake('bench')
      setBusy(null)
      setResults(loadResults())
      rerender()
    }
  }

  async function toggleRecording(clip: Clip) {
    if (recording?.clip === clip.id) {
      const ms = await Bench.stopRecording(clipFile(clip).uri)
      setRecording(null)
      say(`${clip.id}: recorded ${(ms / 1000).toFixed(1)} s`)
      rerender()
      return
    }
    if (recording || busy) return
    const allowed =
      Platform.OS === 'android'
        ? (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) === 'granted'
        : await Bench.requestMicrophone()
    if (!allowed) return Alert.alert('Microphone', 'Allow the microphone in Settings to record the clips.')
    await Bench.startRecording()
    setRecording({ clip: clip.id, since: Date.now() })
  }

  const downloadAsset = (asset: Asset) =>
    exclusive(`download ${asset.id}`, async () => {
      say(`${asset.label}: downloading`)
      await download(asset, (fraction) => setProgress((p) => ({ ...p, [asset.id]: fraction })))
      say(`${asset.label}: ready`)
    })

  const runnable = variants.filter((v) => isDownloaded(assets.find((a) => a.id === v.asset)!))
  const recordedCount = clips.filter((c) => clipMs(c) !== null).length

  const runSelected = () =>
    exclusive('run', async () => {
      for (const variant of runnable.filter((v) => selected.has(v.id))) {
        await run(variant, say)
        setResults(loadResults())
      }
      say('run: done')
    })

  const runSoak = () =>
    exclusive('soak', async () => {
      const variant = variants.find((v) => v.id === soakVariant)!
      const clip = clips.find((c) => c.id === 'en-30')!
      if (clipMs(clip) === null) throw new Error('Record en-30 first')
      say(`soak: ${variant.label} for ${SOAK_MINUTES} min, unplug the phone`)
      await soak(variant, clip, SOAK_MINUTES, say)
      say('soak: done')
    })

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Dictation bench</Text>
      <Text style={styles.muted}>
        {device.model}
        {device.soc ? ` · ${device.soc}` : ''} · {device.os} · {gb(device.ramBytes)} RAM · {device.cores} cores
      </Text>
      <Text style={styles.muted}>
        Now: {Math.round(live.memoryMB)} MB · thermal {live.thermal} · battery {Math.round(live.battery.level * 100)} %
        {live.battery.charging ? ' (charging)' : ''}
        {live.battery.temperatureC !== undefined ? ` · ${live.battery.temperatureC} °C` : ''}
        {busy ? ` · ${busy}…` : ''}
      </Text>

      <Section title={`1. Record the clips (${recordedCount}/${clips.length})`}>
        <Text style={styles.muted}>Read each passage at your normal dictation pace, in a quiet room. Re-record any time.</Text>
        {clips.map((clip) => {
          const ms = clipMs(clip)
          const active = recording?.clip === clip.id
          return (
            <View key={clip.id} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.strong}>
                  {clip.lang === 'en' ? 'English' : 'Français'} · ~{clip.seconds} s
                </Text>
                <Text style={styles.muted}>{ms === null ? 'not recorded' : `${(ms / 1000).toFixed(1)} s`}</Text>
              </View>
              <Text style={styles.passage}>{clip.text}</Text>
              <Button
                label={active ? `Stop (${Math.round((Date.now() - recording.since) / 1000)} s)` : ms === null ? 'Record' : 'Re-record'}
                danger={active}
                disabled={!!busy || (!!recording && !active)}
                onPress={() => void toggleRecording(clip)}
              />
            </View>
          )
        })}
      </Section>

      <Section title="2. Download the models (Wi-Fi)">
        {assets.map((asset) => {
          const bytes = asset.files.reduce((sum, f) => sum + f.bytes, 0)
          const done = isDownloaded(asset)
          const fraction = progress[asset.id]
          return (
            <View key={asset.id} style={[styles.card, styles.row]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.strong}>{asset.label}</Text>
                <Text style={styles.muted}>
                  {gb(bytes)}
                  {asset.files.some((f) => f.unzip) ? ' with its Core ML encoder' : ''}
                  {!done && fraction !== undefined ? ` · ${Math.round(fraction * 100)} %` : ''}
                </Text>
              </View>
              {done ? (
                <Button label="Delete" onPress={() => (removeDownload(asset), rerender())} disabled={!!busy} />
              ) : (
                <Button label="Download" onPress={() => void downloadAsset(asset)} disabled={!!busy} />
              )}
            </View>
          )
        })}
      </Section>

      <Section title="3. Run">
        <Text style={styles.muted}>
          Each variant loads twice (first and warm load) and transcribes every recorded clip. Let the phone cool down
          (thermal nominal) between runs. On iOS, the first run after installing includes Core ML's one-time compile.
        </Text>
        {variants.map((variant) => {
          const ready = runnable.includes(variant)
          const on = ready && selected.has(variant.id)
          return (
            <Pressable
              key={variant.id}
              disabled={!ready}
              onPress={() =>
                setSelected((s) => {
                  const next = new Set(s)
                  next.has(variant.id) ? next.delete(variant.id) : next.add(variant.id)
                  return next
                })
              }
              style={styles.check}
            >
              <Text style={[styles.body, !ready && styles.muted]}>
                {on ? '☑' : '☐'} {variant.label}
                {ready ? '' : ' (download first)'}
              </Text>
            </Pressable>
          )
        })}
        <Button label="Run selected" onPress={runSelected} disabled={!!busy || !!recording || recordedCount === 0} />
      </Section>

      <Section title={`4. Soak (${SOAK_MINUTES} min, unplugged)`}>
        <Text style={styles.muted}>Transcribes the English 30 s clip over and over: battery drain and whether heat slows it down.</Text>
        {runnable.map((variant) => (
          <Pressable key={variant.id} onPress={() => setSoakVariant(variant.id)} style={styles.check}>
            <Text style={styles.body}>
              {soakVariant === variant.id ? '◉' : '○'} {variant.label}
            </Text>
          </Pressable>
        ))}
        <Button label="Start soak" onPress={runSoak} disabled={!!busy || !!recording || !runnable.some((v) => v.id === soakVariant)} />
      </Section>

      <Section title={`5. Results (${results.length})`}>
        <Text style={styles.mono}>{results.length ? report(results) : 'Nothing yet.'}</Text>
        <View style={styles.row}>
          <Button label="Share" onPress={() => void Share.share({ message: report(results) })} disabled={!results.length} />
          <Button
            label="Share raw JSON"
            onPress={() => void Share.share({ message: JSON.stringify(results, null, 1) })}
            disabled={!results.length}
          />
          <Button
            label="Clear"
            onPress={() =>
              Alert.alert('Clear results?', undefined, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Clear', style: 'destructive', onPress: () => (clearResults(), setResults([])) },
              ])
            }
            disabled={!results.length || !!busy}
          />
        </View>
      </Section>

      <Section title="Log">
        <Text style={styles.mono}>{log.join('\n') || '–'}</Text>
      </Section>
    </ScrollView>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{title}</Text>
      {children}
    </View>
  )
}

function Button({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.button, danger && styles.danger, disabled && styles.disabled]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingTop: 64, paddingBottom: 64, gap: 6 },
  title: { fontSize: 28, fontWeight: '700' },
  section: { marginTop: 20, gap: 8 },
  heading: { fontSize: 18, fontWeight: '600' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#ccc', borderRadius: 10, padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  strong: { fontSize: 15, fontWeight: '600' },
  body: { fontSize: 15 },
  passage: { fontSize: 17, lineHeight: 25 },
  muted: { fontSize: 13, color: '#777' },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 11 },
  check: { paddingVertical: 6 },
  button: { backgroundColor: '#000', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9, alignSelf: 'flex-start' },
  danger: { backgroundColor: '#d22' },
  disabled: { opacity: 0.35 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
