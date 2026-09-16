/** `voice` namespace dictionaries (the composer mic seat's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mic.start': '语音输入（点击开始，再次点击结束）',
  'mic.stop': '停止录音并识别',
  'mic.settings': '语音输入设置',
  'status.model': '加载 {model} 模型… {percent}%',
  'status.recording': '录音中… {time}',
  'status.transcribing': '识别中…',
  'status.limit': '已达 2 分钟上限：录音已停止',
  'error.denied': '无法访问麦克风：请在浏览器中允许录音权限',
  'error.failed': '识别失败：{message}',
  'settings.title': '语音输入',
  'settings.model': 'Whisper 模型',
  'settings.language': '语言',
  'settings.language.auto': '自动检测',
  'settings.autoSend': '静音后自动发送',
  'settings.silence': '发送前静音时长',
  'settings.seconds': '{n} 秒',
  'settings.off': '已关闭',
} satisfies Record<string, string>

/** The voice namespace key union. */
export type VoiceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'mic.start': 'Voice input (click to start, click again to stop)',
  'mic.stop': 'Stop recording and transcribe',
  'mic.settings': 'Voice input settings',
  'status.model': 'Loading {model} model… {percent}%',
  'status.recording': 'Recording… {time}',
  'status.transcribing': 'Transcribing…',
  'status.limit': 'Two-minute limit reached: recording stopped',
  'error.denied': 'Microphone unavailable: allow recording in the browser',
  'error.failed': 'Transcription failed: {message}',
  'settings.title': 'Voice input',
  'settings.model': 'Whisper model',
  'settings.language': 'Language',
  'settings.language.auto': 'Detect automatically',
  'settings.autoSend': 'Send automatically after silence',
  'settings.silence': 'Silence before send',
  'settings.seconds': '{n} s',
  'settings.off': 'Off',
} satisfies Record<VoiceKey, string>
