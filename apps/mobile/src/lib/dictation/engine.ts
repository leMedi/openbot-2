import { AppState } from 'react-native'
import { initParakeet, type ParakeetContext } from 'whisper.rn'
import { modelFile } from './model.ts'

/** How long the model stays in memory without dictating. */
const idleMs = 2 * 60_000

/** The model couldn't be loaded on this phone (not enough memory, or the file won't load): no Dictation here. */
export class ModelUnavailable extends Error {}

let context: Promise<ParakeetContext> | undefined
let busy = 0
let idle: ReturnType<typeof setTimeout> | undefined
let releaseWhenDone = false

/**
 * Loads the voice model, or gives the one in memory. Called on the mic tap, so the cold load (about 9 s on an iPhone 17
 * Pro) happens while the owner speaks; a model left alone for 2 minutes, or as the app goes to the background, is
 * released, and nothing loads at launch.
 */
export function loadModel(): Promise<ParakeetContext> {
  clearTimeout(idle)
  const loading = (context ??= initParakeet({ filePath: modelFile().uri, useGpu: true }).catch((error: unknown) => {
    context = undefined
    throw new ModelUnavailable(error instanceof Error ? error.message : String(error))
  }))
  void loading.then(scheduleRelease, () => {})
  return loading
}

/**
 * Keeps the model from being released while a dictation is recording, so one stopped by the app going to the
 * background still transcribes; call what it returns once the recording is transcribed or dropped.
 */
export function holdModel(): () => void {
  busy++
  let held = true
  return () => {
    if (!held) return
    held = false
    busy--
    scheduleRelease()
  }
}

/** Transcribes the WAV recording at `uri`: what was said, raw. */
export async function transcribe(uri: string): Promise<string> {
  busy++
  try {
    const model = await loadModel()
    const { promise } = model.transcribe(uri, { maxThreads: 4 })
    const { result } = await promise
    return result
  } finally {
    busy--
    scheduleRelease()
  }
}

function scheduleRelease() {
  clearTimeout(idle)
  if (busy) return
  if (releaseWhenDone) return releaseModel()
  idle = setTimeout(releaseModel, idleMs)
}

/** Frees the model's memory, once a transcription under way is done. */
export function releaseModel() {
  clearTimeout(idle)
  if (busy) {
    releaseWhenDone = true
    return
  }
  releaseWhenDone = false
  const loaded = context
  context = undefined
  void loaded?.then((model) => model.release(), () => {})
}

AppState.addEventListener('change', (state) => {
  if (state === 'background') releaseModel()
  else if (state === 'active') releaseWhenDone = false
})
