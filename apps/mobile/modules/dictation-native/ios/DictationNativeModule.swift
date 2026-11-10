import AVFoundation
import ExpoModulesCore
import Network

// Dictation's microphone: records straight to 16 kHz mono 16-bit PCM (what whisper.rn reads), reports the level for
// the Listening… bar's waveform, and stops by itself when the system takes the microphone (a call, Siri) or the
// audio route changes. Also tells whether the network costs, for the voice model's download.
public class DictationNativeModule: Module {
  private let engine = AVAudioEngine()
  private var pcm = Data()
  private var peak: Float = 0
  private let lock = NSLock()
  /** The microphone is being read. */
  private var capturing = false
  /** A recording was started and not yet written or cancelled; it may have stopped by itself. */
  private var session = false
  private var observers: [NSObjectProtocol] = []
  private let pathMonitor = NWPathMonitor()

  public func definition() -> ModuleDefinition {
    Name("DictationNative")

    Events("onLevel", "onInterrupted")

    OnCreate {
      self.pathMonitor.start(queue: DispatchQueue(label: "openbot.dictation.network"))
      let center = NotificationCenter.default
      self.observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
        guard
          let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: raw) == .began
        else { return }
        self.interrupt("interruption")
      })
      self.observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: self.engine, queue: .main) { _ in
        self.interrupt("route")
      })
      self.observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { _ in
        self.interrupt("reset")
      })
    }

    OnDestroy {
      self.pathMonitor.cancel()
      for observer in self.observers { NotificationCenter.default.removeObserver(observer) }
      self.observers = []
      self.halt()
    }

    Function("permission") { () -> String in
      if #available(iOS 17.0, *) {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "undetermined"
        }
      }
      switch AVAudioSession.sharedInstance().recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      default: return "undetermined"
      }
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { granted in promise.resolve(granted) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in promise.resolve(granted) }
      }
    }

    AsyncFunction("start") { () in
      if self.session { self.halt(); self.session = false }
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .measurement)
      try audio.setActive(true)

      let input = self.engine.inputNode
      let inputFormat = input.outputFormat(forBus: 0)
      guard
        inputFormat.sampleRate > 0,
        let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
        let converter = AVAudioConverter(from: inputFormat, to: outFormat)
      else { throw Exception(name: "Format", description: "Can't record the microphone (\(inputFormat))") }

      self.lock.lock(); self.pcm = Data(); self.peak = 0; self.lock.unlock()
      input.installTap(onBus: 0, bufferSize: 1600, format: inputFormat) { buffer, _ in
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
        let frames = Int(out.frameLength)
        let level = levelOf(channel[0], frames)
        self.lock.lock()
        self.pcm.append(Data(bytes: channel[0], count: frames * 2))
        self.peak = max(self.peak, level)
        self.lock.unlock()
        self.sendEvent("onLevel", ["level": level])
      }
      self.engine.prepare()
      do {
        try self.engine.start()
      } catch {
        input.removeTap(onBus: 0)
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        throw error
      }
      self.capturing = true
      self.session = true
    }

    AsyncFunction("stop") { (uri: String) -> [String: Double] in
      guard self.session else { throw Exception(name: "Idle", description: "Not recording") }
      self.halt()
      self.session = false
      self.lock.lock(); let data = self.pcm; let peak = self.peak; self.pcm = Data(); self.lock.unlock()
      guard let url = URL(string: uri), url.isFileURL else { throw Exception(name: "Path", description: "Not a file URI: \(uri)") }
      try wav(data).write(to: url)
      return ["durationMs": Double(data.count / 2) / 16.0, "peak": Double(peak)]
    }

    Function("cancel") {
      self.halt()
      self.session = false
      self.lock.lock(); self.pcm = Data(); self.lock.unlock()
    }

    Function("isNetworkMetered") { () -> Bool in
      self.pathMonitor.currentPath.isExpensive
    }
  }

  /** Stops reading the microphone, keeping what was recorded. */
  private func halt() {
    guard capturing else { return }
    capturing = false
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func interrupt(_ reason: String) {
    guard capturing else { return }
    halt()
    sendEvent("onInterrupted", ["reason": reason])
  }
}

/** A buffer's loudness, 0 to 1: its RMS in dBFS from −60 (and below) to 0. */
private func levelOf(_ samples: UnsafePointer<Int16>, _ count: Int) -> Float {
  guard count > 0 else { return 0 }
  var sum: Float = 0
  for i in 0..<count {
    let s = Float(samples[i]) / 32768
    sum += s * s
  }
  let rms = (sum / Float(count)).squareRoot()
  let db = 20 * log10(max(rms, 1e-6))
  return min(1, max(0, (db + 60) / 60))
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
