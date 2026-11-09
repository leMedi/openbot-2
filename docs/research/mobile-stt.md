# On-device speech-to-text for the Expo app

Research for [#82](https://github.com/leMedi/openbot-2/issues/82), part of map #81. The question is which open-source STT engine and model the Expo app should use for Grok-style dictation (Listening… → Transcribing… → editable text) that runs entirely on the phone, in English and French.

Sources were read on 2026-11-09: GitHub repos and release pages, Hugging Face model cards and file listings (sizes come from the HF API), and the sherpa-onnx `asr-models` release assets. The versions checked were whisper.rn 0.7.4 (stable) and 0.8.0-rc.3, whisper.cpp master, sherpa-onnx v2.0.1, react-native-sherpa-onnx 0.4.4, FluidAudio main and Moonshine Voice v0.1.6.

## Recommendation

**Primary: [`whisper.rn`](https://github.com/mybigday/whisper.rn) running NVIDIA [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (GGUF `q4_0`, 356 MB, downloaded on first use), record then transcribe.**

- It is one MIT library with JSI bindings that works in an Expo dev-client build (prebuild). It has been maintained steadily, with releases from 0.7.0 on 2026-07-19 to 0.8.0-rc.3 on 2026-11-09, and it now runs Whisper and Parakeet ([README](https://github.com/mybigday/whisper.rn#nvidia-parakeet-tdt), [0.7.0 release: "integrate parakeet model support"](https://github.com/mybigday/whisper.rn/releases/tag/v0.7.0)).
- Parakeet TDT v3 covers English, French and 23 other European languages, detects the language itself, and adds punctuation and capitalization. Its weights are **CC-BY-4.0**. On FLEURS it scores 4.85 % WER in English and 5.15 % in French ([model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)).
- Record-then-transcribe matches the Grok flow, so we don't need streaming partials for v1. If we want them, `RealtimeTranscriber` with a VAD already supports a `parakeetContext`.

**Fallback: the same library with a Whisper model.** On low-RAM devices, or if Parakeet misbehaves, use `ggml-small-q5_1` (190 MB) or `ggml-base-q5_1` (60 MB). Where accuracy matters more than size, use `large-v3-turbo-q5_0` (574 MB). Whisper on iOS gets the Core ML/ANE encoder, and on Snapdragon 8 Gen 1+ it gets the Hexagon NPU. The fallback is a model swap, not a library swap.

**Watch for later: the sherpa-onnx stack** ([react-native-sherpa-onnx](https://github.com/XDcobra/react-native-sherpa-onnx)). Adopt it if we ever want true live partials with cache-aware streaming models such as Nemotron 3.5 ASR Streaming. Today the RN wrapper is young (44 stars, one maintainer) and pinned to an old sherpa-onnx.

**Before committing, prototype and benchmark:** no primary source publishes Parakeet/Whisper timings for a 30 s clip on a *mid-range* iPhone or Android. Measure on real devices (for example an iPhone 13/SE 3 and a Pixel 7a or Galaxy A5x).

## The owner's question: is Parakeet "unified" English a good fit for a phone?

**Short answer: no, not for v1.** It's the wrong trade for dictation in an EN + FR app. Use Parakeet TDT 0.6B v3 (same family and size, multilingual, CC-BY-4.0) instead.

| | `nvidia/parakeet-unified-en-0.6b` |
|---|---|
| What it is | One FastConformer-RNNT checkpoint (24-layer encoder) trained jointly for offline and streaming. Released 2026-04-07 ([card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b)). |
| Parameters | 600 M |
| Size | The `.nemo` file is 2.47 GB. The sherpa-onnx int8 export is **501 MB** per bundle, with separate bundles for non-streaming and for 240 / 560 / 1120 ms streaming ([sherpa-onnx asr-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models), 2026-04-27 and 2026-05-12). The Core ML encoder is **~590 MB int8 / ~1.19 GB fp16** per latency variant, plus ~22 MB of decoder, joint and preprocessor ([FluidInference/parakeet-unified-en-0.6b-coreml](https://huggingface.co/FluidInference/parakeet-unified-en-0.6b-coreml)). |
| ONNX / sherpa-onnx | Yes. The export was added in sherpa-onnx PR #3556 (v1.13.0, 2026-04-28), and buffered streaming in PR #3575 (2026-05-09, v1.13.2). |
| Core ML | Yes, through the community conversion by FluidAudio (Swift). **Caveat:** the int8 encoder "fails to load on *every* compute unit" on A16 (iPhone 14 Pro), and FluidAudio says to use fp16 (1.19 GB) on iOS ([FluidAudio Models.md, issue #828](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Models.md)). |
| Runs from React Native? | **Not out of the box.** react-native-sherpa-onnx 0.4.4 bundles sherpa-onnx **1.12.35** (2026-04-03), which predates unified support. We would have to bump or fork it. [@fluidinference/react-native-fluidaudio](https://github.com/FluidInference/react-native-fluidaudio) is iOS-only, defaults to Parakeet EOU, and doesn't document unified. |
| Streaming | Yes, but **buffered**: left context is recomputed for every chunk, and cache-aware streaming is not supported. Latency is configurable from 2.08 s down to 0.16 s. WER (OpenASR set, no PnC) is 5.91 offline, 6.29 at 1.12 s, 6.52 at 0.56 s, 7.35 at 0.24 s and 15.63 at 0.08 s (card). Recomputing the context costs extra compute and battery on a phone. |
| RTF on mid-range phones | **No primary source publishes one.** NVIDIA tested only on V100/A100/A6000/DGX Spark. FluidAudio reports 123–143× RTFx in batch and ~66× streaming at 2.08 s on an **M5 Pro Mac**, not a phone. |
| Licence | **NVIDIA Open Model License**, not CC-BY-4.0. The card's front matter says `license: other` / `nvidia-open-model-license`, and allows commercial use. The FluidInference Core ML repo labels itself CC-BY-4.0, which doesn't match upstream, so treat the NVIDIA licence as the governing one. |
| Cost of English-only | French speakers get nothing usable. We'd need a second model (another ~350–500 MB download), a language picker or detection, and two code paths. The model's one real advantage, offline-grade WER at 0.5–2 s streaming latency, matters for live captions. Grok-style dictation shows "Transcribing…" after release anyway, and v3 transcribes a short clip in one pass. |

If English-only live partials ever become a goal, look at NVIDIA's newer options before unified-en:

- [`nemotron-3.5-asr-streaming-0.6b`](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) (2026-06-04, OpenMDW-1.1): cache-aware streaming, multilingual including French. FLEURS WER at 1.12 s is 7.91 % in English and 9.03 % in French. sherpa-onnx int8 bundles are 475 MB (2026-07-09).
- [`nemotron-labs-unified-asr-0.6b`](https://huggingface.co/nvidia/nemotron-labs-unified-asr-0.6b) (on HF since 2026-08-21, card date 10/27/26, OpenMDW-1.1): a 25-language "unified" sibling. French WER is 5.53 offline and 6.96 at 1.12 s. Only a Core ML conversion exists so far (FluidAudio), and FluidAudio notes int8 lost French accuracy. There is no sherpa-onnx export yet.

## Comparison

### Engines and React Native bindings

| Binding | Engine | Expo / New Arch | Acceleration | Streaming | Licence | Health (2026-11-09) |
|---|---|---|---|---|---|---|
| [whisper.rn](https://github.com/mybigday/whisper.rn) | whisper.cpp (vendored), Whisper + Parakeet TDT v3 GGUF | Needs prebuild (dev client). JSI bindings. 0.7.4 fixed RN 0.87 bridge compat. Prebuilt Android libs. | iOS: Metal plus a Core ML/ANE encoder for Whisper (iOS 15+). Android: experimental Hexagon NPU on SM8450+ for Whisper. **VAD and Parakeet stay on the CPU** (README). | `RealtimeTranscriber` slices audio with a VAD, so it is pseudo-streaming. Works with Whisper or Parakeet. | MIT | 809★. 0.7.4 is stable, 0.8.0-rc.3 shipped today. Active. |
| [react-native-sherpa-onnx](https://github.com/XDcobra/react-native-sherpa-onnx) | sherpa-onnx 1.12.35 (ONNX Runtime) | TurboModule, with an Expo config plugin (for the download manager). iOS XCFramework fetched at `pod install`. | CPU, NNAPI, XNNPACK, QNN (Android); Core ML (iOS) | True online recognizers (transducer, paraformer, NeMo CTC…), native mic capture | MIT (wrapper), Apache-2.0 ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)) | 44★, created 2026-01, last npm release 2026-09-08. Single maintainer. Upstream sherpa-onnx (15.8k★, v2.0.1 on 2026-10-26) is very healthy. |
| [@fluidinference/react-native-fluidaudio](https://github.com/FluidInference/react-native-fluidaudio) | FluidAudio (Core ML on ANE) | Expo SDK 52+, dev build. **iOS 17+ only.** | ANE | Yes (Parakeet EOU by default) | No licence in repo metadata. FluidAudio itself is Apache-2.0. | 13★, so a thin wrapper. FluidAudio (3.3k★) is very active. |
| Moonshine Voice ([moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine)) | Own runtime; also runs in sherpa-onnx | iOS/Android SDKs. A community `@siteed/moonshine.rn` exists. | — | Built for live streaming | MIT, models MIT (except legacy non-English non-streaming models) | 11.4k★, v0.1.6 on 2026-11-06 |

### Models

| Model | Size on device | EN / FR | Notes |
|---|---|---|---|
| **Parakeet TDT 0.6B v3** | GGUF q4_0 356 MB, q4_k 416 MB, q8_0 669 MB ([whisper.rn](https://github.com/mybigday/whisper.rn#nvidia-parakeet-tdt)). sherpa-onnx int8 487 MB. Core ML int8 encoder ~595 MB. | Both (25 langs, auto-detect). FLEURS 4.85 / 5.15 % WER. | CC-BY-4.0, punctuation and capitalization, timestamps. Released 2025-08-14. Offline (TDT). Chunked streaming is possible but not native. |
| Parakeet unified en 0.6B | 501 MB (sherpa int8), 590 MB / 1.19 GB (Core ML) | EN only | See above. NVIDIA Open Model License. |
| Whisper tiny / base | 78 / 148 MB (ggml f16), base-q5_1 60 MB. RAM ~273 / ~388 MB ([whisper.cpp](https://github.com/ggml-org/whisper.cpp#memory-usage)) | Both (99 langs) | MIT. Fast, but accuracy is weak, especially outside English. |
| Whisper small | 488 MB f16, q5_1 190 MB, q8_0 264 MB. RAM ~852 MB (f16). | Both | MIT. A reasonable fallback. |
| Whisper large-v3-turbo | 1.6 GB f16, q5_0 574 MB, q8_0 874 MB. Core ML encoder 1.17 GB. | Both | MIT. Best Whisper accuracy, heavy for mid-range phones. |
| Moonshine tiny/base en | sherpa-onnx quantized 29 MB / 111 MB (2026-02-27) | **No French STT** (STT covers en, es, de, zh, ja, ko, vi, tl, uk, ar) | MIT. Excellent for English-only and very small. Ruled out for v1 by the lack of French. |
| SenseVoice small | sherpa-onnx int8 (2024-07 / 2025-09) | **No French** (zh, en, ja, ko, yue) | Ruled out. |
| Nemotron 3.5 ASR streaming 0.6B | sherpa-onnx int8 475 MB per latency | Both | OpenMDW-1.1. Cache-aware streaming. The candidate if we ever want live partials. |
| Canary 180M flash | sherpa-onnx int8 153 MB | en, es, de, fr | Small multilingual option. Not checked in depth (licence and accuracy not verified here). |

### Speed (30 s clip)

No first-party benchmark gives a 30 s clip on mid-range phones for any of these. The closest primary numbers are below; treat them as upper bounds.

- **whisper.rn Hexagon NPU, Galaxy S25 Ultra (Snapdragon 8 Elite, flagship), encoder ms per 30 s window** ([README](https://github.com/mybigday/whisper.rn#hexagon-npu-experimental)): tiny 56, base 83, small 190, large-v3-turbo-q8_0 612. Decode time comes on top and scales with the length of the text.
- **FluidAudio on an M5 Pro Mac (ANE)**: Parakeet unified batch 123× RTFx. Parakeet TDT v3 is in the same range.
- whisper.cpp says the Core ML encoder is "more than x3 faster" than CPU-only on Apple Silicon, and the first run on a device is slow while the ANE compiles the model.

Since Parakeet in whisper.rn runs on the CPU, the benchmark should compare Parakeet v3 q4_0 on CPU against Whisper small with the Core ML/NPU encoder, on a mid-range iPhone and a mid-range Android.

## Practical notes for the spec

- Download models on first use; don't bundle them. All the good options are 190–600 MB, and whisper.rn's own example app downloads at runtime for this reason. Offer a "Download voice model (~360 MB)" step with Wi-Fi gating.
- Parakeet input in whisper.rn must be 16 kHz mono 16-bit PCM WAV. Compressed formats are not decoded, so the recorder must produce PCM (`@fugood/react-native-audio-pcm-stream` is the documented adapter).
- whisper.rn requires prebuild, which is fine because #81 already settled on a dev-client build. Expo Go is not supported by any of the options.
- Out of scope per #81 but worth noting: the platform recognizers (Apple Speech / SpeechAnalyzer, Android `SpeechRecognizer`) are not open source, so this research did not consider them.
