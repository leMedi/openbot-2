import { useState } from 'react'
import { ActivityIndicator, Modal, Pressable, type StyleProp, StyleSheet, Switch, Text, View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle } from 'react-native-svg'
import { listeningClock } from '../lib/dictation/clock.ts'
import { modelDownload, useModelState, voiceModel } from '../lib/dictation/model.ts'
import type { DictationToast } from '../lib/dictation/use-dictation.ts'
import { radii, useColors } from '../lib/theme.ts'
import { CheckIcon, CloseIcon, MicIcon } from './icons.tsx'

/**
 * Use cellular data, for the voice model's download: the owner's choice before it starts, then the download's own.
 */
export function useCellularChoice(): [boolean, (cellular: boolean) => void] {
  const model = useModelState()
  const [chosen, setChosen] = useState(false)
  const cellular = model.kind === 'downloading' || model.kind === 'failed' ? model.cellular : chosen
  const choose = (value: boolean) => {
    setChosen(value)
    modelDownload.setCellular(value)
  }
  return [cellular, choose]
}

/** How far the voice model's download is, as a thin bar. */
export function ModelProgress({ fraction, style }: { fraction: number; style?: StyleProp<ViewStyle> }) {
  const colors = useColors()
  return (
    <View style={[styles.track, { backgroundColor: colors.controlTrack }, style]}>
      <View style={[styles.progress, { width: `${Math.round(fraction * 100)}%`, backgroundColor: colors.blue }]} />
    </View>
  )
}

/** The composer's mic; while the voice model downloads, a ring round it shows how far. */
export function MicButton({ onPress }: { onPress: () => void }) {
  const colors = useColors()
  const model = useModelState()
  const fraction = model.kind === 'downloading' ? model.fraction : undefined
  const size = 34
  const r = 15.5
  const around = 2 * Math.PI * r
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Dictate"
      accessibilityHint={fraction !== undefined ? `Downloading the voice model, ${Math.floor(fraction * 100)}%` : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.round, { opacity: pressed ? 0.6 : 1 }]}
    >
      {fraction !== undefined && (
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.controlTrack} strokeWidth={2} fill="none" />
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={colors.blue}
            strokeWidth={2}
            fill="none"
            strokeDasharray={`${around * Math.max(0.02, fraction)} ${around}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </Svg>
      )}
      <MicIcon size={18} color={fraction !== undefined ? colors.blue : colors.mutedForeground} />
    </Pressable>
  )
}

/** Listening…: ✕ (discard), the live waveform, the time (a countdown over the last 10 s), ✓ (transcribe). */
export function ListeningBar({ levels, elapsedMs, onCancel, onDone }: { levels: number[]; elapsedMs: number; onCancel: () => void; onDone: () => void }) {
  const colors = useColors()
  const clock = listeningClock(elapsedMs)
  const ending = clock.secondsLeft !== undefined
  return (
    <View style={styles.bar} accessibilityLabel="Listening…">
      <Pressable accessibilityRole="button" accessibilityLabel="Discard dictation" hitSlop={6} onPress={onCancel} style={({ pressed }) => [styles.round, { backgroundColor: colors.background, opacity: pressed ? 0.6 : 1 }]}>
        <CloseIcon size={14} color={colors.foreground} />
      </Pressable>
      <View style={styles.middle}>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>Listening…</Text>
        <Waveform levels={levels} />
        <Text
          accessibilityLabel={ending ? `Stopping in ${clock.secondsLeft} seconds` : clock.time}
          style={[styles.time, { color: ending ? colors.redForeground : colors.mutedForeground }, ending && styles.ending]}
        >
          {ending ? `0:${String(clock.secondsLeft).padStart(2, '0')}` : clock.time}
        </Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Done dictating" hitSlop={6} onPress={onDone} style={({ pressed }) => [styles.round, { backgroundColor: colors.primary, opacity: pressed ? 0.7 : 1 }]}>
        <CheckIcon size={16} color={colors.primaryForeground} />
      </Pressable>
    </View>
  )
}

/** The last levels heard as bars, newest on the right. */
function Waveform({ levels }: { levels: number[] }) {
  const colors = useColors()
  return (
    <View style={styles.wave} importantForAccessibility="no-hide-descendants">
      {levels.map((level, index) => (
        <View key={index} style={[styles.waveBar, { height: 3 + Math.round(level * level * 21), backgroundColor: colors.foreground }]} />
      ))}
    </View>
  )
}

export function TranscribingBar() {
  const colors = useColors()
  return (
    <View style={[styles.bar, styles.transcribing]} accessibilityLabel="Transcribing…" accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={colors.mutedForeground} />
      <Text style={[styles.label, { color: colors.mutedForeground }]}>Transcribing…</Text>
    </View>
  )
}

/** Dictation's message over the composer: Didn't catch that, Couldn't transcribe · Try again, … */
export function DictationToastView({ toast, onClose }: { toast: DictationToast; onClose: () => void }) {
  const colors = useColors()
  return (
    <View accessibilityLiveRegion="polite" style={[styles.toast, { backgroundColor: colors.popover, borderColor: colors.border }]}>
      <Text style={[styles.toastText, { color: colors.foreground }]}>{toast.message}</Text>
      {toast.retry && (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={toast.retry}>
          <Text style={[styles.toastAction, { color: colors.link }]}>Try again</Text>
        </Pressable>
      )}
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={8} onPress={onClose}>
        <CloseIcon size={12} color={colors.mutedForeground} />
      </Pressable>
    </View>
  )
}

/**
 * The voice model's sheet, from the mic: "Download the voice model (356 MB)?" on Wi-Fi unless Use cellular data is
 * on; then its progress, which carries on with the sheet closed and the app in the background.
 */
export function ModelSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const model = useModelState()
  const [cellular, setCellular] = useCellularChoice()

  let title = 'Dictation runs on your phone.'
  let body = `Download the voice model (${voiceModel.size})?`
  if (model.kind === 'downloading') {
    title = 'Downloading the voice model'
    body = model.offline
      ? 'Waiting for a connection.'
      : model.waitingForWifi
        ? 'Waiting for Wi-Fi. Turn on Use cellular data to download now.'
        : `${Math.floor(model.fraction * 100)}% of ${voiceModel.size}. It carries on if you leave the app.`
  } else if (model.kind === 'failed') {
    title = 'The download stopped'
    body = model.message
  } else if (model.kind === 'ready') {
    title = 'The voice model is ready'
    body = 'Tap the mic to dictate. Your voice never leaves your phone.'
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable accessibilityLabel="Close" style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]} pointerEvents="box-none">
        <View style={[styles.card, { backgroundColor: colors.popover }]}>
          <Text accessibilityRole="header" style={[styles.sheetTitle, { color: colors.foreground }]}>
            {title}
          </Text>
          <Text style={[styles.sheetBody, { color: colors.mutedForeground }]}>{body}</Text>
          {model.kind === 'downloading' && <ModelProgress fraction={model.fraction} />}
          {model.kind !== 'ready' && (
            <View style={styles.switchRow}>
              <Text style={[styles.switchLabel, { color: colors.foreground }]}>Use cellular data</Text>
              <Switch value={cellular} onValueChange={setCellular} trackColor={{ true: colors.controlChecked }} />
            </View>
          )}
          {model.kind === 'absent' || model.kind === 'failed' ? (
            <>
              <SheetButton
                label={model.kind === 'failed' ? 'Try again' : 'Download'}
                primary
                onPress={() => modelDownload.start({ cellular })}
              />
              <SheetButton label="Not now" onPress={onClose} />
            </>
          ) : model.kind === 'downloading' ? (
            <>
              <SheetButton label="OK" primary onPress={onClose} />
              <SheetButton label="Cancel download" danger onPress={() => modelDownload.cancel()} />
            </>
          ) : (
            <SheetButton label="OK" primary onPress={onClose} />
          )}
        </View>
      </View>
    </Modal>
  )
}

function SheetButton({ label, primary = false, danger = false, onPress }: { label: string; primary?: boolean; danger?: boolean; onPress: () => void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: primary ? colors.primary : colors.secondary, opacity: pressed ? 0.75 : 1 }]}
    >
      <Text style={[styles.buttonLabel, { color: primary ? colors.primaryForeground : danger ? colors.destructiveForeground : colors.foreground }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  round: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34 },
  middle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 15 },
  time: { fontSize: 15, fontVariant: ['tabular-nums'], minWidth: 36, textAlign: 'right' },
  ending: { fontWeight: '600' },
  wave: { flex: 1, height: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, overflow: 'hidden' },
  waveBar: { width: 3, borderRadius: 1.5 },
  transcribing: { justifyContent: 'center', paddingHorizontal: 8 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    alignSelf: 'center',
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginBottom: 6,
  },
  toastText: { fontSize: 14 },
  toastAction: { fontSize: 14, fontWeight: '600' },
  sheet: { position: 'absolute', left: 8, right: 8, bottom: 0 },
  card: { borderRadius: radii.xl, padding: 20, gap: 12 },
  sheetTitle: { fontSize: 17, fontWeight: '600' },
  sheetBody: { fontSize: 15, lineHeight: 20 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  progress: { height: 4 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 40 },
  switchLabel: { fontSize: 16 },
  button: { minHeight: 48, borderRadius: radii['3xl'], alignItems: 'center', justifyContent: 'center' },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
})
