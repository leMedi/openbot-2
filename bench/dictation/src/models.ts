import { Platform } from 'react-native'

// The models under test and the configurations each runs in. Files are downloaded on the phone, never bundled.

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

type Os = 'ios' | 'android'

export type AssetFile = {
  url: string
  /** The name it's saved under in the asset's folder. */
  name: string
  bytes: number
  /** A zipped Core ML encoder, unzipped next to the model. */
  unzip?: boolean
  only?: Os
}

export type Asset = { id: string; label: string; files: AssetFile[]; only?: Os }

// whisper.cpp finds a Core ML encoder by the model's file name (ggml-small.bin → ggml-small-encoder.mlmodelc), so
// quantized Whisper models are saved under their unquantized names, one folder each.
export const allAssets: Asset[] = [
  {
    id: 'parakeet-q4_0',
    label: 'Parakeet TDT 0.6B v3 q4_0',
    files: [{ url: hf('ggml-org/parakeet-GGUF', 'ggml-parakeet-tdt-0.6b-v3-q4_0.bin'), name: 'model.bin', bytes: 355_615_679 }],
  },
  {
    id: 'whisper-small-q5_1',
    label: 'Whisper small q5_1',
    files: [
      { url: hf('ggerganov/whisper.cpp', 'ggml-small-q5_1.bin'), name: 'ggml-small.bin', bytes: 190_085_487 },
      { url: hf('ggerganov/whisper.cpp', 'ggml-small-encoder.mlmodelc.zip'), name: 'encoder.zip', bytes: 163_083_239, unzip: true, only: 'ios' },
    ],
  },
  {
    id: 'whisper-turbo-q5_0',
    label: 'Whisper large-v3-turbo q5_0',
    files: [
      { url: hf('ggerganov/whisper.cpp', 'ggml-large-v3-turbo-q5_0.bin'), name: 'ggml-large-v3-turbo.bin', bytes: 574_041_195 },
      { url: hf('ggerganov/whisper.cpp', 'ggml-large-v3-turbo-encoder.mlmodelc.zip'), name: 'encoder.zip', bytes: 1_173_393_014, unzip: true, only: 'ios' },
    ],
  },
  // The Hexagon NPU can't run q5 models (they fall back to the CPU), so Android also tries q8_0 there.
  {
    id: 'whisper-small-q8_0',
    label: 'Whisper small q8_0',
    only: 'android',
    files: [{ url: hf('ggerganov/whisper.cpp', 'ggml-small-q8_0.bin'), name: 'ggml-small.bin', bytes: 264_464_607 }],
  },
  {
    id: 'whisper-turbo-q8_0',
    label: 'Whisper large-v3-turbo q8_0',
    only: 'android',
    files: [{ url: hf('ggerganov/whisper.cpp', 'ggml-large-v3-turbo-q8_0.bin'), name: 'ggml-large-v3-turbo.bin', bytes: 874_188_075 }],
  },
]

export type Variant = {
  id: string
  label: string
  asset: string
  engine: 'parakeet' | 'whisper'
  /** Metal on iOS; on Android the Hexagon NPU when the phone has one (Whisper only), else the CPU. */
  useGpu: boolean
  /** iOS Whisper: the Core ML encoder on the Neural Engine. whisper.rn ignores it when useGpu is on. */
  useCoreML?: boolean
  only?: Os
}

export const allVariants: Variant[] = [
  { id: 'parakeet', label: 'Parakeet q4_0', asset: 'parakeet-q4_0', engine: 'parakeet', useGpu: true },
  { id: 'small-coreml', label: 'Whisper small q5_1 · Core ML', asset: 'whisper-small-q5_1', engine: 'whisper', useGpu: false, useCoreML: true, only: 'ios' },
  { id: 'small-metal', label: 'Whisper small q5_1 · Metal', asset: 'whisper-small-q5_1', engine: 'whisper', useGpu: true, only: 'ios' },
  { id: 'turbo-coreml', label: 'Whisper turbo q5_0 · Core ML', asset: 'whisper-turbo-q5_0', engine: 'whisper', useGpu: false, useCoreML: true, only: 'ios' },
  { id: 'turbo-metal', label: 'Whisper turbo q5_0 · Metal', asset: 'whisper-turbo-q5_0', engine: 'whisper', useGpu: true, only: 'ios' },
  { id: 'small-cpu', label: 'Whisper small q5_1 · CPU', asset: 'whisper-small-q5_1', engine: 'whisper', useGpu: false, only: 'android' },
  { id: 'turbo-cpu', label: 'Whisper turbo q5_0 · CPU', asset: 'whisper-turbo-q5_0', engine: 'whisper', useGpu: false, only: 'android' },
  { id: 'small-npu', label: 'Whisper small q8_0 · NPU', asset: 'whisper-small-q8_0', engine: 'whisper', useGpu: true, only: 'android' },
  { id: 'turbo-npu', label: 'Whisper turbo q8_0 · NPU', asset: 'whisper-turbo-q8_0', engine: 'whisper', useGpu: true, only: 'android' },
]

const here = (thing: { only?: Os }) => !thing.only || thing.only === Platform.OS

export const assets = allAssets.filter(here).map((asset) => ({ ...asset, files: asset.files.filter(here) }))
export const variants = allVariants.filter(here)

/** The file whisper.rn loads for an asset: the first one, which is never a zip. */
export const modelFile = (asset: Asset) => asset.files[0].name
