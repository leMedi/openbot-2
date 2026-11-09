package expo.modules.benchnative

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

// What the benchmark needs that no Expo package gives: the app's memory, the thermal status, the battery level, the
// device's identity, and recording the microphone straight to 16 kHz mono 16-bit WAV (what whisper.rn reads).
class BenchNativeModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw CodedException("No context")
  private var recorder: AudioRecord? = null
  private var reader: Thread? = null
  private val pcm = ByteArrayOutputStream()

  override fun definition() = ModuleDefinition {
    Name("BenchNative")

    // VmRSS: resident memory, native heap included (whisper.cpp's weights and buffers live there).
    Function("memoryBytes") {
      val line = File("/proc/self/status").readLines().firstOrNull { it.startsWith("VmRSS:") }
      line?.split(Regex("\\s+"))?.getOrNull(1)?.toDoubleOrNull()?.times(1024) ?: -1.0
    }

    Function("thermalState") {
      if (Build.VERSION.SDK_INT < 29) return@Function "unknown"
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      when (power.currentThermalStatus) {
        PowerManager.THERMAL_STATUS_NONE -> "none"
        PowerManager.THERMAL_STATUS_LIGHT -> "light"
        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
        PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
        PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
        PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
        else -> "unknown"
      }
    }

    Function("battery") {
      val battery = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
      val status = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val plugged = (status?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      mapOf(
        "level" to battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) / 100.0,
        "charging" to plugged,
        "lowPower" to power.isPowerSaveMode,
        // Battery temperature in °C, the closest thing Android gives to "how hot is the phone".
        "temperatureC" to (status?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0,
      )
    }

    Function("deviceInfo") {
      val activity = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val memory = ActivityManager.MemoryInfo().also { activity.getMemoryInfo(it) }
      mapOf(
        "platform" to "android",
        "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
        "name" to Build.DEVICE,
        "soc" to if (Build.VERSION.SDK_INT >= 31) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}" else Build.HARDWARE,
        "os" to "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
        "ramBytes" to memory.totalMem.toDouble(),
        "cores" to Runtime.getRuntime().availableProcessors(),
      )
    }

    // The JS side asks for RECORD_AUDIO with PermissionsAndroid before calling this.
    @SuppressLint("MissingPermission")
    AsyncFunction("startRecording") {
      if (recorder != null) throw CodedException("Already recording")
      val size = maxOf(AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), 8192)
      val record = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
      if (record.state != AudioRecord.STATE_INITIALIZED) throw CodedException("Microphone unavailable")
      synchronized(pcm) { pcm.reset() }
      record.startRecording()
      recorder = record
      reader = Thread {
        val buffer = ByteArray(size)
        while (recorder === record) {
          val n = record.read(buffer, 0, buffer.size)
          if (n > 0) synchronized(pcm) { pcm.write(buffer, 0, n) }
        }
      }.also { it.start() }
    }

    // Writes what was recorded to `uri` as a WAV file and returns its length in milliseconds.
    AsyncFunction("stopRecording") { uri: String ->
      val record = recorder ?: throw CodedException("Not recording")
      recorder = null
      reader?.join()
      reader = null
      record.stop()
      record.release()
      val data = synchronized(pcm) { pcm.toByteArray().also { pcm.reset() } }
      val path = Uri.parse(uri).path ?: throw CodedException("Not a file URI: $uri")
      FileOutputStream(path).use { it.write(wavHeader(data.size)); it.write(data) }
      data.size / 2 / 16.0
    }
  }
}

private fun wavHeader(size: Int): ByteArray = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
  put("RIFF".toByteArray()); putInt(36 + size); put("WAVE".toByteArray())
  put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(16000); putInt(32000); putShort(2); putShort(16)
  put("data".toByteArray()); putInt(size)
}.array()
