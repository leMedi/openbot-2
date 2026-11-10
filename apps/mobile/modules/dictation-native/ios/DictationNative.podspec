Pod::Spec.new do |s|
  s.name           = 'DictationNative'
  s.version        = '0.1.0'
  s.summary        = 'Records the microphone for Dictation as 16 kHz mono 16-bit WAV'
  s.description    = 'Records the microphone for Dictation as 16 kHz mono 16-bit WAV, the input whisper.rn reads.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
