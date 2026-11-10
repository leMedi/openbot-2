package expo.modules.dictationnative

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

// Dictation's microphone: records straight to 16 kHz mono 16-bit PCM (what whisper.rn reads), reports the level for
// the Listening… bar's waveform, and stops by itself when the system silences it (a call, another app taking the
// microphone). Also tells whether the network costs, for the voice model's download.
class DictationNativeModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw CodedException("No context")
  private var recorder: AudioRecord? = null
  private var reader: Thread? = null
  private val pcm = ByteArrayOutputStream()
  @Volatile private var peak = 0f
  /** A recording was started and not yet written or cancelled; it may have stopped by itself. */
  private var session = false
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null

  override fun definition() = ModuleDefinition {
    Name("DictationNative")

    Events("onLevel", "onInterrupted")

    OnDestroy { halt() }

    // Android asks through PermissionsAndroid; these keep the module's shape the same on both platforms.
    Function("permission") { "undetermined" }
    AsyncFunction("requestPermission") { false }

    // The JS side has RECORD_AUDIO before calling this.
    @SuppressLint("MissingPermission")
    AsyncFunction("start") {
      if (session) halt()
      val size = max(AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), 8192)
      val record = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
      if (record.state != AudioRecord.STATE_INITIALIZED) {
        record.release()
        throw CodedException("The microphone isn't available")
      }
      synchronized(pcm) { pcm.reset() }
      peak = 0f
      record.startRecording()
      if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        record.release()
        throw CodedException("The microphone is in use")
      }
      recorder = record
      session = true
      watchSilencing(record)
      reader = Thread {
        // 100 ms at a time: 1600 samples.
        val buffer = ByteArray(3200)
        while (recorder === record) {
          val n = record.read(buffer, 0, buffer.size)
          if (n < 0) {
            Handler(Looper.getMainLooper()).post { interrupt(record, "error") }
            break
          }
          if (n == 0) continue
          val level = levelOf(buffer, n)
          synchronized(pcm) { pcm.write(buffer, 0, n) }
          peak = max(peak, level)
          sendEvent("onLevel", mapOf("level" to level.toDouble()))
        }
      }.also { it.start() }
    }

    AsyncFunction("stop") { uri: String ->
      if (!session) throw CodedException("Not recording")
      halt()
      session = false
      val data = synchronized(pcm) { pcm.toByteArray().also { pcm.reset() } }
      val path = Uri.parse(uri).path ?: throw CodedException("Not a file URI: $uri")
      FileOutputStream(path).use { it.write(wavHeader(data.size)); it.write(data) }
      mapOf("durationMs" to data.size / 2 / 16.0, "peak" to peak.toDouble())
    }

    Function("cancel") {
      halt()
      session = false
      synchronized(pcm) { pcm.reset() }
    }

    Function("isNetworkMetered") {
      (context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered
    }

    // The voice model's download on Android goes through the system's DownloadManager: Android cuts an app's own
    // connections once it's in the background, and DownloadManager carries on (after the app is closed, too), waiting
    // for Wi-Fi itself unless cellular data is allowed. It writes to the app's external files; `installDownload` moves
    // the finished file into the app's documents.
    Function("startDownload") { url: String, name: String, title: String, cellular: Boolean ->
      val dir = File(context.getExternalFilesDir(null), "dictation").apply { mkdirs() }
      val target = File(dir, name)
      if (target.exists()) target.delete()
      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle(title)
        .setDestinationUri(Uri.fromFile(target))
        .setAllowedOverMetered(cellular)
        .setAllowedOverRoaming(false)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
      downloads().enqueue(request).toDouble()
    }

    Function("downloadStatus") { id: Double ->
      downloads().query(DownloadManager.Query().setFilterById(id.toLong())).use { cursor ->
        if (!cursor.moveToFirst()) return@Function mapOf("status" to "missing", "bytes" to 0.0, "reason" to 0.0)
        val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
        val bytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        val state = when (status) {
          DownloadManager.STATUS_SUCCESSFUL -> "done"
          DownloadManager.STATUS_FAILED -> "failed"
          DownloadManager.STATUS_PAUSED -> when (reason) {
            DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "waiting-wifi"
            DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "waiting-network"
            else -> "paused"
          }
          else -> "running"
        }
        mapOf("status" to state, "bytes" to bytes.toDouble(), "reason" to reason.toDouble())
      }
    }

    Function("cancelDownload") { id: Double ->
      downloads().remove(id.toLong())
    }

    // Moves the finished download into `uri` (the app's documents) and forgets it in DownloadManager.
    Function("installDownload") { id: Double, uri: String ->
      val manager = downloads()
      val source = manager.query(DownloadManager.Query().setFilterById(id.toLong())).use { cursor ->
        if (!cursor.moveToFirst()) throw CodedException("The download is gone")
        Uri.parse(cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))).path
      } ?: throw CodedException("The download has no file")
      val target = File(Uri.parse(uri).path ?: throw CodedException("Not a file URI: $uri"))
      target.parentFile?.mkdirs()
      val from = File(source)
      if (!from.renameTo(target)) {
        from.copyTo(target, overwrite = true)
        from.delete()
      }
      // The file is ours now; removing the entry no longer deletes it.
      manager.remove(id.toLong())
      target.length().toDouble()
    }
  }

  private fun downloads() = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

  /** Stops reading the microphone, keeping what was recorded. */
  private fun halt() {
    val record = recorder ?: return
    recorder = null
    unwatchSilencing()
    reader?.join(500)
    reader = null
    try {
      record.stop()
    } catch (_: IllegalStateException) {
    }
    record.release()
  }

  private fun interrupt(record: AudioRecord, reason: String) {
    if (recorder !== record) return
    halt()
    sendEvent("onInterrupted", mapOf("reason" to reason))
  }

  // Android 10+ keeps a recording running but feeds it silence while a call or another app has the microphone.
  private fun watchSilencing(record: AudioRecord) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val callback = object : AudioManager.AudioRecordingCallback() {
      override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
        val mine = configs.firstOrNull { it.clientAudioSessionId == record.audioSessionId } ?: return
        if (mine.isClientSilenced) interrupt(record, "silenced")
      }
    }
    audio.registerAudioRecordingCallback(callback, Handler(Looper.getMainLooper()))
    recordingCallback = callback
  }

  private fun unwatchSilencing() {
    val callback = recordingCallback ?: return
    recordingCallback = null
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioRecordingCallback(callback)
  }
}

/** A buffer's loudness, 0 to 1: its RMS in dBFS from −60 (and below) to 0. */
private fun levelOf(bytes: ByteArray, count: Int): Float {
  val samples = count / 2
  if (samples == 0) return 0f
  val buffer = ByteBuffer.wrap(bytes, 0, count).order(ByteOrder.LITTLE_ENDIAN)
  var sum = 0.0
  for (i in 0 until samples) {
    val s = buffer.short / 32768.0
    sum += s * s
  }
  val rms = sqrt(sum / samples)
  val db = 20 * log10(max(rms, 1e-6))
  return min(1.0, max(0.0, (db + 60) / 60)).toFloat()
}

private fun wavHeader(size: Int): ByteArray = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
  put("RIFF".toByteArray()); putInt(36 + size); put("WAVE".toByteArray())
  put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(16000); putInt(32000); putShort(2); putShort(16)
  put("data".toByteArray()); putInt(size)
}.array()
