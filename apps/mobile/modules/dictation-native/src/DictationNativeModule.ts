import { NativeModule, requireNativeModule } from 'expo'

export type RecordingResult = {
  /** How long the recording is. */
  durationMs: number
  /** Its loudest moment, 0 (silent) to 1, on the same scale as the levels. */
  peak: number
}

export type SystemDownloadStatus = 'running' | 'waiting-wifi' | 'waiting-network' | 'paused' | 'done' | 'failed' | 'missing'

type Events = {
  /** The microphone's level, 0 (silent) to 1, about ten times a second while recording. */
  onLevel(event: { level: number }): void
  /** Recording stopped by itself: a call, Siri, another app taking the microphone or a change of audio route. */
  onInterrupted(event: { reason: string }): void
}

declare class DictationNativeModule extends NativeModule<Events> {
  /** iOS: whether the microphone may be used ('undetermined' until asked). Android asks through PermissionsAndroid. */
  permission(): 'granted' | 'denied' | 'undetermined'
  /** iOS: asks for the microphone; resolves whether it's allowed. */
  requestPermission(): Promise<boolean>
  /** Starts recording the microphone in memory. */
  start(): Promise<void>
  /**
   * Stops recording (if it hadn't stopped by itself) and writes what was recorded to the file at `uri` as 16 kHz mono
   * 16-bit WAV, what whisper.rn reads.
   */
  stop(uri: string): Promise<RecordingResult>
  /** Stops recording and drops it. */
  cancel(): void
  /**
   * Android: hands a download to the system's DownloadManager, which goes on in the background and after the app is
   * closed, on Wi-Fi only unless `cellular`. Resolves its id.
   */
  startDownload(url: string, name: string, title: string, cellular: boolean): number
  /** Android: where a DownloadManager download is. */
  downloadStatus(id: number): { status: SystemDownloadStatus; bytes: number; reason: number }
  /** Android: stops a DownloadManager download and deletes what it got. */
  cancelDownload(id: number): void
  /** Android: moves a finished DownloadManager download to the file at `uri`; resolves its size. */
  installDownload(id: number, uri: string): number
  /** Whether the network the phone is on costs: cellular or a hotspot, also under a VPN. */
  isNetworkMetered(): boolean
}

/** Dictation's microphone: no Expo package records straight to the WAV whisper.rn needs on both platforms. */
export default requireNativeModule<DictationNativeModule>('DictationNative')
