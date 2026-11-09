import AVFoundation
import ExpoModulesCore
import UIKit

// What the benchmark needs that no Expo package gives: the app's memory footprint, the thermal state, the battery
// level, the device's identity, and recording the microphone straight to 16 kHz mono 16-bit WAV (what whisper.rn reads).
public class BenchNativeModule: Module {
  private let engine = AVAudioEngine()
  private var pcm = Data()
  private let lock = NSLock()
  private var recording = false

  public func definition() -> ModuleDefinition {
    Name("BenchNative")

    // phys_footprint: what Xcode's memory gauge shows and what jetsam judges the app by.
    Function("memoryBytes") { () -> Double in
      var info = task_vm_info_data_t()
      var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
      let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
          task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
      }
      return result == KERN_SUCCESS ? Double(info.phys_footprint) : -1
    }

    Function("thermalState") { () -> String in
      switch ProcessInfo.processInfo.thermalState {
      case .nominal: return "nominal"
      case .fair: return "fair"
      case .serious: return "serious"
      case .critical: return "critical"
      @unknown default: return "unknown"
      }
    }

    Function("battery") { () -> [String: Any] in
      UIDevice.current.isBatteryMonitoringEnabled = true
      let state = UIDevice.current.batteryState
      return [
        "level": Double(UIDevice.current.batteryLevel),
        "charging": state == .charging || state == .full,
        "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
      ]
    }

    Function("deviceInfo") { () -> [String: Any] in
      var system = utsname()
      uname(&system)
      let machine = withUnsafeBytes(of: &system.machine) { raw in
        String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
      }
      return [
        "platform": "ios",
        "model": machine,
        "name": UIDevice.current.model,
        "os": "iOS \(UIDevice.current.systemVersion)",
        "ramBytes": Double(ProcessInfo.processInfo.physicalMemory),
        "cores": ProcessInfo.processInfo.processorCount,
      ]
    }

    AsyncFunction("requestMicrophone") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { granted in promise.resolve(granted) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in promise.resolve(granted) }
      }
    }

    AsyncFunction("startRecording") { () in
      if self.recording { throw Exception(name: "Busy", description: "Already recording") }
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement)
      try session.setActive(true)

      let input = self.engine.inputNode
      let inputFormat = input.outputFormat(forBus: 0)
      guard
        let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
        let converter = AVAudioConverter(from: inputFormat, to: outFormat)
      else { throw Exception(name: "Format", description: "Can't convert \(inputFormat) to 16 kHz mono") }

      self.lock.lock(); self.pcm = Data(); self.lock.unlock()
      input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / inputFormat.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
          if fed { status.pointee = .noDataNow; return nil }
          fed = true
          status.pointee = .haveData
          return buffer
        }
        guard error == nil, let channel = out.int16ChannelData else { return }
        let bytes = Data(bytes: channel[0], count: Int(out.frameLength) * 2)
        self.lock.lock(); self.pcm.append(bytes); self.lock.unlock()
      }
      self.engine.prepare()
      try self.engine.start()
      self.recording = true
    }

    // Writes what was recorded to `uri` as a WAV file and returns its length in milliseconds.
    AsyncFunction("stopRecording") { (uri: String) -> Double in
      guard self.recording else { throw Exception(name: "Idle", description: "Not recording") }
      self.engine.inputNode.removeTap(onBus: 0)
      self.engine.stop()
      self.recording = false
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

      self.lock.lock(); let data = self.pcm; self.pcm = Data(); self.lock.unlock()
      guard let url = URL(string: uri), url.isFileURL else { throw Exception(name: "Path", description: "Not a file URI: \(uri)") }
      try wav(data).write(to: url)
      return Double(data.count / 2) / 16.0
    }
  }
}

private func wav(_ pcm: Data) -> Data {
  var header = Data()
  func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
  func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
  header.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + pcm.count))
  header.append(contentsOf: Array("WAVE".utf8))
  header.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
  header.append(contentsOf: Array("data".utf8)); u32(UInt32(pcm.count))
  return header + pcm
}
