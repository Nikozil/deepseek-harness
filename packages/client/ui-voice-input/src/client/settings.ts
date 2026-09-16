/**
 * Durable voice-input preferences. The composer mic seat owns this surface, so
 * the preferences live in the browser's localStorage under one plugin key —
 * the Host settings registry has no voice namespace, and a per-browser record
 * matches the per-browser model cache.
 */

/** Quantized ONNX Whisper checkpoints the seat can run, smallest first. */
export type VoiceModel = 'tiny' | 'base' | 'small'

/** Hugging Face repositories backing each model choice, with size hints. */
export const VOICE_MODELS: Readonly<Record<VoiceModel, { readonly repo: string; readonly megabytes: number }>> = {
  tiny: { repo: 'Xenova/whisper-tiny', megabytes: 40 },
  base: { repo: 'Xenova/whisper-base', megabytes: 80 },
  small: { repo: 'Xenova/whisper-small', megabytes: 250 },
}

/** Spoken language handed to Whisper; 'auto' lets the model detect it. */
export type VoiceLanguage = 'auto' | 'ru' | 'en' | 'zh'

/** The voice seat's persisted shape. */
export interface VoiceSettings {
  /** Which quantized checkpoint to run. */
  model: VoiceModel
  /** Language hint for the recognizer. */
  language: VoiceLanguage
  /** Deliver the draft through submit() once silence outlasts {@link silenceMs}. */
  autoSend: boolean
  /** Silence length (ms) that ends an auto-send recording. */
  silenceMs: number
}

/** Factory defaults: plain dictation (the user presses Enter), auto language. */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  model: 'base',
  language: 'auto',
  autoSend: false,
  silenceMs: 1500,
}

/** Selectable silence lengths (ms) for the settings panel. */
export const SILENCE_CHOICES: readonly number[] = [500, 1000, 1500, 2000, 3000, 5000]

/** localStorage key owned by the voice seat. */
const STORAGE_KEY = 'dsh.ui-voice-input'

/** The storage slice the settings read and write (injectable for tests). */
type SettingsStore = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The browser storage, typed possibly-absent: lib.dom declares localStorage
 * unconditionally, but private modes, quotas, and non-browser runs make the
 * honest view `Storage | undefined`.
 */
const browserStore = (globalThis as { readonly localStorage?: SettingsStore | undefined }).localStorage

/** Narrow one raw field, falling back to the default when out of domain. */
function oneOf<T extends string>(value: unknown, domain: readonly T[], fallback: T): T {
  return typeof value === 'string' && (domain as readonly string[]).includes(value) ? value as T : fallback
}

/**
 * Read the persisted settings, merged over the defaults field by field: a
 * missing record, a partial record, or a corrupt one all yield a complete
 * settings object rather than an error.
 * @param store - storage backend; the browser's localStorage by default.
 * @returns the effective settings.
 */
export function loadVoiceSettings(store: SettingsStore | undefined = browserStore): VoiceSettings {
  if (store === undefined) return { ...DEFAULT_VOICE_SETTINGS }
  let raw: unknown
  try {
    raw = JSON.parse(store.getItem(STORAGE_KEY) ?? '{}') as unknown
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS }
  }
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const silenceMs = typeof record.silenceMs === 'number' && Number.isFinite(record.silenceMs)
    ? Math.min(10_000, Math.max(300, Math.round(record.silenceMs)))
    : DEFAULT_VOICE_SETTINGS.silenceMs
  return {
    model: oneOf(record.model, ['tiny', 'base', 'small'] as const, DEFAULT_VOICE_SETTINGS.model),
    language: oneOf(record.language, ['auto', 'ru', 'en', 'zh'] as const, DEFAULT_VOICE_SETTINGS.language),
    autoSend: typeof record.autoSend === 'boolean' ? record.autoSend : DEFAULT_VOICE_SETTINGS.autoSend,
    silenceMs,
  }
}

/**
 * Persist the settings.
 * @param settings - complete settings to store.
 * @param store - storage backend; the browser's localStorage by default.
 */
export function saveVoiceSettings(
  settings: VoiceSettings,
  store: SettingsStore | undefined = browserStore,
): void {
  if (store === undefined) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage may be unavailable (private mode, quota): the session keeps the
    // in-memory values, and the next run simply returns to the defaults.
  }
}
