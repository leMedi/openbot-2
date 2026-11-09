import { Directory, File, Paths } from 'expo-file-system'
import { unzip } from 'react-native-zip-archive'
import { initParakeet, initWhisper, type ParakeetContext, type WhisperContext } from 'whisper.rn'
import Bench, { type Battery, type DeviceInfo } from '../modules/bench-native'
import { type Asset, modelFile, type Variant, assets } from './models'
import { type Clip, clips } from './passages'
import { wer } from './wer'

const MB = 1024 * 1024
const root = new Directory(Paths.document, 'bench')
const modelsDir = new Directory(root, 'models')
const clipsDir = new Directory(root, 'clips')
const resultsFile = new File(root, 'results.json')

export function ensureDirs() {
  for (const dir of [root, modelsDir, clipsDir]) dir.create({ idempotent: true, intermediates: true })
}

const plainPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''))

// Models

const assetDir = (asset: Asset) => new Directory(modelsDir, asset.id)
const doneMarker = (asset: Asset) => new File(assetDir(asset), '.done')

export const isDownloaded = (asset: Asset) => doneMarker(asset).exists

export async function download(asset: Asset, onProgress: (fraction: number) => void) {
  const dir = assetDir(asset)
  dir.create({ idempotent: true, intermediates: true })
  const total = asset.files.reduce((sum, file) => sum + file.bytes, 0)
  let before = 0
  for (const spec of asset.files) {
    const target = new File(dir, spec.name)
    if (target.exists) target.delete()
    const task = File.createDownloadTask(spec.url, target, {
      onProgress: ({ bytesWritten }) => onProgress((before + bytesWritten) / total),
    })
    const file = await task.downloadAsync()
    if (!file) throw new Error(`Download of ${spec.name} paused`)
    if (spec.unzip) {
      await unzip(plainPath(file.uri), plainPath(dir.uri))
      file.delete()
      const junk = new Directory(dir, '__MACOSX')
      if (junk.exists) junk.delete()
    }
    before += spec.bytes
  }
  doneMarker(asset).create()
  onProgress(1)
}

export function removeDownload(asset: Asset) {
  const dir = assetDir(asset)
  if (dir.exists) dir.delete()
}

// Clips

export const clipFile = (clip: Clip) => new File(clipsDir, `${clip.id}.wav`)

/** The recorded clip's length in ms (16 kHz mono 16-bit, after the 44-byte header), or null if not recorded. */
export function clipMs(clip: Clip): number | null {
  const file = clipFile(clip)
  return file.exists ? (file.size - 44) / 32 : null
}

// Measuring

export type Sample = { memoryMB: number; thermal: string; battery: Battery }

export function sample(): Sample {
  return { memoryMB: Bench.memoryBytes() / MB, thermal: Bench.thermalState(), battery: Bench.battery() }
}

/** Polls the app's memory every 200 ms while `work` runs and reports the highest value seen. */
async function withPeakMemory<T>(work: () => Promise<T>): Promise<{ value: T; peakMB: number }> {
  let peak = Bench.memoryBytes()
  const timer = setInterval(() => (peak = Math.max(peak, Bench.memoryBytes())), 200)
  try {
    const value = await work()
    return { value, peakMB: Math.max(peak, Bench.memoryBytes()) / MB }
  } finally {
    clearInterval(timer)
  }
}

type Context = { kind: 'whisper'; ctx: WhisperContext } | { kind: 'parakeet'; ctx: ParakeetContext }

async function load(variant: Variant): Promise<Context> {
  const asset = assets.find((a) => a.id === variant.asset)!
  const filePath = new File(assetDir(asset), modelFile(asset)).uri
  if (variant.engine === 'parakeet') return { kind: 'parakeet', ctx: await initParakeet({ filePath, useGpu: variant.useGpu }) }
  return {
    kind: 'whisper',
    ctx: await initWhisper({ filePath, useGpu: variant.useGpu, useCoreMLIos: !!variant.useCoreML }),
  }
}

async function transcribe(context: Context, clip: Clip): Promise<string> {
  const path = clipFile(clip).uri
  const job =
    context.kind === 'parakeet'
      ? context.ctx.transcribe(path, { maxThreads: 4 })
      : context.ctx.transcribe(path, { language: clip.lang, maxThreads: 4 })
  const { result } = await job.promise
  return result.trim()
}

const now = () => performance.now()

export type ClipResult = {
  clip: string
  audioMs: number
  transcribeMs: number
  /** Seconds of audio per second of compute: 10 means a 30 s clip takes 3 s. */
  speed: number
  wer: number
  text: string
}

export type RunResult = {
  kind: 'run'
  variant: string
  label: string
  at: string
  device: DeviceInfo
  /** What whisper.rn actually used: Metal/NPU when true, else the CPU (with Core ML for the encoder when asked). */
  gpu: boolean
  reasonNoGPU: string
  /** The first load in this app session: on iOS with Core ML, the first ever compiles the model for the Neural Engine. */
  firstLoadMs: number
  warmLoadMs: number
  baselineMB: number
  peakMB: number
  start: Sample
  end: Sample
  clips: ClipResult[]
  error?: string
}

export type SoakResult = {
  kind: 'soak'
  variant: string
  label: string
  at: string
  device: DeviceInfo
  clip: string
  minutes: number
  runs: number
  transcribeMs: number[]
  thermal: string[]
  start: Sample
  end: Sample
  error?: string
}

export type Result = RunResult | SoakResult

const release = (context: Context) => context.ctx.release()

/** Loads the variant twice (first and warm load), transcribes every recorded clip once, and records it all. */
export async function run(variant: Variant, log: (line: string) => void): Promise<RunResult> {
  const recorded = clips.filter((clip) => clipMs(clip) !== null)
  const start = sample()
  const result: RunResult = {
    kind: 'run',
    variant: variant.id,
    label: variant.label,
    at: new Date().toISOString(),
    device: Bench.deviceInfo(),
    gpu: false,
    reasonNoGPU: '',
    firstLoadMs: 0,
    warmLoadMs: 0,
    baselineMB: start.memoryMB,
    peakMB: start.memoryMB,
    start,
    end: start,
    clips: [],
  }
  try {
    log(`${variant.label}: loading`)
    let t = now()
    const first = await withPeakMemory(() => load(variant))
    result.firstLoadMs = now() - t
    result.peakMB = first.peakMB
    await release(first.value)

    t = now()
    const { value: context, peakMB } = await withPeakMemory(() => load(variant))
    result.warmLoadMs = now() - t
    result.peakMB = Math.max(result.peakMB, peakMB)
    result.gpu = context.ctx.gpu
    result.reasonNoGPU = context.ctx.reasonNoGPU
    log(`${variant.label}: loaded in ${Math.round(result.firstLoadMs)} / ${Math.round(result.warmLoadMs)} ms`)

    try {
      for (const clip of recorded) {
        t = now()
        const { value: text, peakMB } = await withPeakMemory(() => transcribe(context, clip))
        const transcribeMs = now() - t
        const audioMs = clipMs(clip)!
        result.peakMB = Math.max(result.peakMB, peakMB)
        result.clips.push({ clip: clip.id, audioMs, transcribeMs, speed: audioMs / transcribeMs, wer: wer(clip.text, text), text })
        log(`${variant.label}: ${clip.id} in ${(transcribeMs / 1000).toFixed(1)} s`)
      }
    } finally {
      await release(context)
    }
  } catch (error) {
    result.error = String(error)
    log(`${variant.label}: ${result.error}`)
  }
  result.end = sample()
  await save(result)
  return result
}

/** Transcribes one clip over and over for `minutes`, to see the battery drain and whether heat slows it down. */
export async function soak(variant: Variant, clip: Clip, minutes: number, log: (line: string) => void): Promise<SoakResult> {
  const start = sample()
  const result: SoakResult = {
    kind: 'soak',
    variant: variant.id,
    label: variant.label,
    at: new Date().toISOString(),
    device: Bench.deviceInfo(),
    clip: clip.id,
    minutes,
    runs: 0,
    transcribeMs: [],
    thermal: [start.thermal],
    start,
    end: start,
  }
  try {
    const context = await load(variant)
    try {
      const until = now() + minutes * 60_000
      while (now() < until) {
        const t = now()
        await transcribe(context, clip)
        result.transcribeMs.push(now() - t)
        result.thermal.push(Bench.thermalState())
        result.runs++
        if (result.runs % 5 === 0) log(`soak: ${result.runs} runs, ${Bench.thermalState()}`)
      }
    } finally {
      await release(context)
    }
  } catch (error) {
    result.error = String(error)
    log(`soak: ${result.error}`)
  }
  result.end = sample()
  await save(result)
  return result
}

// Results

export function loadResults(): Result[] {
  try {
    return resultsFile.exists ? (JSON.parse(resultsFile.textSync()) as Result[]) : []
  } catch {
    return []
  }
}

async function save(result: Result) {
  await resultsFile.write(JSON.stringify([...loadResults(), result], null, 1))
}

export function clearResults() {
  if (resultsFile.exists) resultsFile.delete()
}

const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN)
const pct = (value: number) => `${(value * 100).toFixed(1)} %`

/** A Markdown report to paste into the ticket: one table of runs, the soaks, then every transcript. */
export function report(results: Result[]): string {
  const runs = results.filter((r): r is RunResult => r.kind === 'run')
  const soaks = results.filter((r): r is SoakResult => r.kind === 'soak')
  const device = results[0]?.device
  const lines: string[] = []
  if (device) {
    const ram = (device.ramBytes / 1024 ** 3).toFixed(1)
    lines.push(`**${device.model}** ${device.soc ? `(${device.soc}) ` : ''}· ${device.os} · ${ram} GB RAM · ${device.cores} cores`, '')
  }
  if (runs.length) {
    lines.push(
      '| Variant | Accel | First / warm load | 10 s | 30 s | 60 s | WER en | WER fr | Peak RAM | Thermal |',
      '|---|---|---|---|---|---|---|---|---|---|',
    )
    for (const r of runs) {
      const bySeconds = (s: number) => {
        const hits = r.clips.filter((c) => c.clip.endsWith(`-${s}`))
        return hits.length ? `${(avg(hits.map((c) => c.transcribeMs)) / 1000).toFixed(1)} s (${avg(hits.map((c) => c.speed)).toFixed(0)}×)` : '–'
      }
      const werOf = (lang: string) => {
        const hits = r.clips.filter((c) => c.clip.startsWith(lang))
        return hits.length ? pct(avg(hits.map((c) => c.wer))) : '–'
      }
      const accel = r.gpu ? 'GPU/NPU' : r.variant.includes('coreml') ? 'CPU + Core ML' : `CPU${r.reasonNoGPU ? ` (${r.reasonNoGPU})` : ''}`
      lines.push(
        `| ${r.label}${r.error ? ` ⚠️ ${r.error}` : ''} | ${accel} | ${(r.firstLoadMs / 1000).toFixed(1)} / ${(r.warmLoadMs / 1000).toFixed(1)} s | ` +
          `${bySeconds(10)} | ${bySeconds(30)} | ${bySeconds(60)} | ${werOf('en')} | ${werOf('fr')} | ` +
          `${Math.round(r.peakMB - r.baselineMB)} MB (+${Math.round(r.baselineMB)}) | ${r.start.thermal} → ${r.end.thermal} |`,
      )
    }
    lines.push('', 'Times are per clip, averaged over English and French; × is seconds of audio per second of compute.')
  }
  for (const s of soaks) {
    const first = s.transcribeMs.slice(0, 3)
    const last = s.transcribeMs.slice(-3)
    const drop = s.start.battery.level - s.end.battery.level
    const temp = s.start.battery.temperatureC !== undefined ? `, battery ${s.start.battery.temperatureC} → ${s.end.battery.temperatureC} °C` : ''
    lines.push(
      '',
      `**Soak** ${s.label}, ${s.clip} for ${s.minutes} min${s.error ? ` ⚠️ ${s.error}` : ''}: ${s.runs} runs, ` +
        `first ${(avg(first) / 1000).toFixed(1)} s → last ${(avg(last) / 1000).toFixed(1)} s per clip; ` +
        `battery ${pct(s.start.battery.level)} → ${pct(s.end.battery.level)} (−${pct(drop)}${s.start.battery.charging ? ', was charging!' : ''})${temp}; ` +
        `thermal ${[...new Set(s.thermal)].join(' → ')}`,
    )
  }
  if (runs.length) {
    lines.push('', '<details><summary>Transcripts</summary>', '')
    for (const r of runs) {
      lines.push(`#### ${r.label}`, '')
      for (const c of r.clips) lines.push(`- **${c.clip}** (WER ${pct(c.wer)}): ${c.text}`)
      lines.push('')
    }
    lines.push('</details>')
  }
  return lines.join('\n')
}
