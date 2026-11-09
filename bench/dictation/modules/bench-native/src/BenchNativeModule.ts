import { NativeModule, requireNativeModule } from 'expo'

export type Battery = { level: number; charging: boolean; lowPower: boolean; temperatureC?: number }
export type DeviceInfo = {
  platform: 'ios' | 'android'
  model: string
  name: string
  soc?: string
  os: string
  ramBytes: number
  cores: number
}

declare class BenchNativeModule extends NativeModule<{}> {
  memoryBytes(): number
  thermalState(): string
  battery(): Battery
  deviceInfo(): DeviceInfo
  /** iOS only; Android asks through PermissionsAndroid. */
  requestMicrophone(): Promise<boolean>
  startRecording(): Promise<void>
  /** Writes the recording to `uri` as 16 kHz mono 16-bit WAV; resolves with its length in ms. */
  stopRecording(uri: string): Promise<number>
}

export default requireNativeModule<BenchNativeModule>('BenchNative')
