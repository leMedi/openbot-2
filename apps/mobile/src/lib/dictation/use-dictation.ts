import { Directory, File, Paths } from 'expo-file-system'
import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Alert, AppState, Linking, PermissionsAndroid, Platform } from 'react-native'
import Native from '../../../modules/dictation-native/index.ts'
import { listeningClock } from './clock.ts'
import { holdModel, loadModel, ModelUnavailable, transcribe } from './engine.ts'
import { deleteIfThere, modelDownload } from './model.ts'
import { heardText } from './text.ts'

export type DictationPhase =
  | { kind: 'idle' }
  | { kind: 'listening'; startedAt: number }
  | { kind: 'transcribing' }

/** A message over the composer; Try again transcribes the recording kept from a failed transcription. */
export type DictationToast = { message: string; retry?: () => void }

/** Recordings wait in the cache until transcribed; the audio never leaves the phone. */
const recordings = new Directory(Paths.cache, 'dictation')
// What a previous run of the app left (it was killed mid-dictation): kept recordings last only until the app closes.
try {
  if (recordings.exists) recordings.delete()
} catch {
  // Left for the OS, which clears the cache.
}

/** Below this level (about −54 dBFS) throughout, nothing was said. */
const silentPeak = 0.1
/** Shorter than this, nothing was said. */
const shortestMs = 300
/** The waveform's bars: the last levels heard. */
const bars = 28

const unavailable = 'Dictation isn’t available on this phone'
const nothingHeard = 'Didn’t catch that'
const failed = 'Couldn’t transcribe'
const microphoneFailed = 'Couldn’t use the microphone'

/** The recording kept from a failed transcription for Try again, until the next dictation. */
let kept: File | undefined

function dropKept() {
  if (kept?.exists) kept.delete()
  kept = undefined
}

async function microphoneAllowed(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
    if (await PermissionsAndroid.check(permission)) return true
    return (await PermissionsAndroid.request(permission)) === PermissionsAndroid.RESULTS.GRANTED
  }
  const now = Native.permission()
  if (now === 'granted') return true
  if (now === 'denied') return false
  return Native.requestPermission()
}

function microphoneDenied() {
  Alert.alert('OpenBot needs the microphone for dictation', 'Allow the microphone for OpenBot in Settings, then tap the mic again.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
  ])
}

/**
 * Dictation in a composer (spec: Dictation): a tap on the mic records, ✓ (or the 2-minute limit, or an interruption)
 * transcribes on the phone, and `onText` gets what was said, to put at the cursor. ✕ drops the recording. Without the
 * voice model, `onNeedModel` opens its download sheet.
 */
export function useDictation({ onText, onNeedModel }: { onText: (text: string) => void; onNeedModel: () => void }) {
  const [phase, setPhase] = useState<DictationPhase>({ kind: 'idle' })
  const [levels, setLevels] = useState<number[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [toast, setToast] = useState<DictationToast>()
  const phaseRef = useRef(phase)
  const release = useRef<() => void>(undefined)
  const mounted = useRef(true)
  const latest = useRef({ onText, onNeedModel })
  useLayoutEffect(() => {
    latest.current = { onText, onNeedModel }
  })

  const setPhaseTo = useCallback((next: DictationPhase) => {
    phaseRef.current = next
    if (mounted.current) setPhase(next)
  }, [])
  const showToast = useCallback((next: DictationToast | undefined) => {
    if (next) AccessibilityInfo.announceForAccessibility(next.message)
    if (mounted.current) setToast(next)
  }, [])

  /** Back to the mic: idle, and the model no longer held for this dictation. */
  const backToIdle = useCallback(() => {
    setPhaseTo({ kind: 'idle' })
    release.current?.()
    release.current = undefined
  }, [setPhaseTo])

  // Try again runs the transcription once more, as `run` is defined below.
  const runAgain = useRef<(file: File) => Promise<void>>(undefined)
  const run = useCallback(
    async (file: File) => {
      setPhaseTo({ kind: 'transcribing' })
      try {
        const text = heardText(await transcribe(file.uri))
        deleteIfThere(file)
        if (text) latest.current.onText(text)
        else showToast({ message: nothingHeard })
      } catch (error) {
        if (error instanceof ModelUnavailable) {
          deleteIfThere(file)
          showToast({ message: unavailable })
        } else {
          kept = file
          showToast({
            message: failed,
            retry: () => {
              showToast(undefined)
              if (phaseRef.current.kind !== 'idle' || !kept?.exists) return
              const again = kept
              kept = undefined
              const hold = holdModel()
              void runAgain.current?.(again).finally(hold)
            },
          })
        }
      } finally {
        backToIdle()
      }
    },
    [backToIdle, setPhaseTo, showToast],
  )

  useLayoutEffect(() => {
    runAgain.current = run
  })

  /** Stops recording and transcribes it: ✓, the time limit, or an interruption. */
  const finish = useCallback(async () => {
    if (phaseRef.current.kind !== 'listening') return
    setPhaseTo({ kind: 'transcribing' })
    recordings.create({ idempotent: true, intermediates: true })
    const file = new File(recordings, `${Date.now()}.wav`)
    try {
      const { durationMs, peak } = await Native.stop(file.uri)
      if (durationMs < shortestMs || peak < silentPeak) {
        deleteIfThere(file)
        showToast({ message: nothingHeard })
        backToIdle()
        return
      }
      await run(file)
    } catch {
      // The microphone wouldn't stop or the recording couldn't be written: there's nothing to transcribe.
      deleteIfThere(file)
      showToast({ message: microphoneFailed })
      backToIdle()
    }
  }, [backToIdle, run, setPhaseTo, showToast])

  /** ✕: drops the recording. */
  const cancel = useCallback(() => {
    if (phaseRef.current.kind !== 'listening') return
    Native.cancel()
    backToIdle()
  }, [backToIdle])

  /** The mic: starts listening, or asks for the model or the microphone first. */
  const start = useCallback(async () => {
    if (phaseRef.current.kind !== 'idle') return
    showToast(undefined)
    if (modelDownload.state.kind !== 'ready') return latest.current.onNeedModel()
    if (!(await microphoneAllowed())) return microphoneDenied()
    if (phaseRef.current.kind !== 'idle' || !mounted.current) return
    dropKept()
    release.current = holdModel()
    try {
      await Native.start()
    } catch {
      backToIdle()
      return showToast({ message: microphoneFailed })
    }
    setLevels([])
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    AccessibilityInfo.announceForAccessibility('Listening…')
    setNow(Date.now())
    const startedAt = Date.now()
    setPhaseTo({ kind: 'listening', startedAt })
    // Loads while the owner speaks; a phone that can't load it stops this dictation at once.
    loadModel().catch(() => {
      const now = phaseRef.current
      if (now.kind !== 'listening' || now.startedAt !== startedAt) return
      Native.cancel()
      backToIdle()
      showToast({ message: unavailable })
    })
  }, [backToIdle, setPhaseTo, showToast])

  // The level for the waveform, the clock, and what stops a recording by itself.
  useEffect(() => {
    if (phase.kind !== 'listening') return
    const level = Native.addListener('onLevel', ({ level }) => setLevels((all) => [...all.slice(1 - bars), level]))
    const interrupted = Native.addListener('onInterrupted', () => void finish())
    const app = AppState.addEventListener('change', (state) => state === 'background' && void finish())
    const tick = setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (listeningClock(at - phase.startedAt).over) void finish()
    }, 250)
    return () => {
      level.remove()
      interrupted.remove()
      app.remove()
      clearInterval(tick)
    }
  }, [phase, finish])

  // Leaving the chat drops a recording; a transcription under way still lands in its draft.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (phaseRef.current.kind === 'listening') {
        Native.cancel()
        phaseRef.current = { kind: 'idle' }
        backToIdle()
      }
    }
  }, [backToIdle])

  // A message goes after a while; one with Try again stays until dismissed or the next dictation, as the recording does.
  useEffect(() => {
    if (!toast || toast.retry) return
    const timer = setTimeout(() => setToast(undefined), 3500)
    return () => clearTimeout(timer)
  }, [toast])

  const elapsedMs = phase.kind === 'listening' ? Math.max(0, now - phase.startedAt) : 0
  return { phase, levels, elapsedMs, toast, start, finish, cancel, dismissToast: () => setToast(undefined) }
}
