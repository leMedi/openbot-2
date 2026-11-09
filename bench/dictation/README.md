# Dictation bench

A throwaway Expo app for [Benchmark dictation models on real phones](https://github.com/leMedi/openbot-2/issues/92) (map: [Mobile app (Expo) with on-device dictation](https://github.com/leMedi/openbot-2/issues/81)). It lives on the `bench/dictation` branch, which is never merged.

It compares, through `whisper.rn` 0.8.0-rc.3:

| | iOS | Android |
|---|---|---|
| Parakeet TDT 0.6B v3 q4_0 (356 MB) | Metal if whisper.rn uses it, else CPU | CPU (whisper.rn keeps Parakeet there) |
| Whisper small q5_1 (190 MB) | Core ML encoder on the Neural Engine, and Metal | CPU |
| Whisper large-v3-turbo q5_0 (574 MB) | Core ML encoder (1.2 GB), and Metal | CPU |
| Whisper small / turbo q8_0 | – | Hexagon NPU on Snapdragon 8 Gen 1 and newer (q5 can't run there) |

For each variant it measures:
- the first load and a warm load
- the transcription time of each recorded clip (10, 30 and 60 s, in English and French)
- the app's peak memory: phys_footprint on iOS, VmRSS on Android
- the thermal state
- the word error rate against the passage that was read

The 5-minute soak adds the battery drain and whether heat slows transcription down.

## Install

- **iPhone:** `npx expo run:ios --device --configuration Release` (team `BUH75GV43F`, set in `app.json`).
- **Android:** `cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`, then `adb install -r app/build/outputs/apk/release/app-release.apk`. Or copy the APK to the phone.

Run `npx expo prebuild` first if `ios/` or `android/` is missing.

## Use

1. Record the six passages in a quiet room.
2. Download the models over Wi-Fi.
3. Run all variants. Let the phone cool down to nominal between runs.
4. Run one soak per serious candidate, unplugged.
5. Share the report and paste it into the ticket.
