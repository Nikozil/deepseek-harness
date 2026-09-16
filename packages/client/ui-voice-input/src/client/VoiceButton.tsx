/**
 * The voice-input mic seat, browser half: occupies the composer's
 * `conversation.input.left` list slot. One button starts/stops a local
 * recording (getUserMedia → 16 kHz mono capture); on stop the buffered audio
 * crosses to a Blob-module worker that runs the quantized WASM Whisper
 * pipeline loaded once from the CDN and cached by the browser. The recognized
 * text appends to the composer draft through the standard inputActions
 * seat; with auto-send enabled the draft also submits after the configured
 * silence, so the utterance becomes a message without a second gesture.
 * Preferences live in localStorage ({@link ./settings.ts}); a small popover
 * beside the mic edits them. Every state rides one phase value, surfaced in
 * the compact status bubble above the button.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Tooltip, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the input-kit standard seat merge (useInput + inputActions) and
// the locale plugin's Context merge ride the declaring packages.
import type {
  PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { WHISPER_WORKER_SOURCE, VOICE_TAP_WORKLET_SOURCE } from './whisper-worker.ts'
import {
  DEFAULT_VOICE_SETTINGS, SILENCE_CHOICES, VOICE_MODELS,
  loadVoiceSettings, saveVoiceSettings,
  type VoiceLanguage, type VoiceModel, type VoiceSettings,
} from './settings.ts'
import css from './VoiceButton.module.css'

/** Props of the composer mic seat: the list-slot runtime share + the locale seat. */
export type VoiceButtonProps = PropsRuntime<'conversation.input.left'> & {
  /** Translate a dictionary key of the `voice` namespace (framework-injected). */
  t: TranslateNS<'voice'>
}

/** One button state, from idle through the recording/transcribing round trip. */
type VoicePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'recording'; readonly since: number }
  | { readonly kind: 'transcribing' }
  | { readonly kind: 'loading'; readonly percent: number | undefined }
  | { readonly kind: 'failed'; readonly message: string; readonly seq: number }

/** Live capture session owned between start and stop. */
interface Recorder {
  readonly stream: MediaStream
  readonly context: AudioContext
  readonly source: MediaStreamAudioSourceNode
  readonly node: AudioWorkletNode
  /** Captured 16 kHz mono frames, in order. */
  chunks: Float32Array[]
  /** Total captured sample count (chunks' running sum). */
  frames: number
  /** How long voice has been detected (ms) in the current recording. */
  voicedMs: number
  /** How long the current trailing silence has run (ms). */
  silentMs: number
}

/** Silence gate: below this RMS the sample window counts as quiet. */
const SILENCE_RMS = 0.01
/** Speech must total at least this before trailing silence may end a take. */
const MIN_VOICED_MS = 300
/** Hard recording cap: Whisper transcribes long takes slowly on a CPU. */
const MAX_RECORDING_MS = 120_000
/** Failed-phase auto-clear, so a stale error never parks beside the composer. */
const FAILURE_HOLD_MS = 6000

/** Microphone capture + WASM inference exist in this browser. */
function supported(): boolean {
  // mediaDevices is typed non-optional but is absent in old browsers and
  // non-secure contexts; the cast keeps the runtime probe honest.
  const capture = (navigator as { readonly mediaDevices?: { readonly getUserMedia?: unknown } }).mediaDevices
  return typeof navigator !== 'undefined'
    && typeof Worker !== 'undefined'
    && typeof AudioContext !== 'undefined'
    && capture?.getUserMedia !== undefined
}

/** Format an elapsed span as m:ss for the recording bubble. */
function elapsedText(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`
}

/** Merge captured frames into one contiguous buffer for the pipeline. */
function mergeChunks(chunks: readonly Float32Array[], frames: number): Float32Array {
  const audio = new Float32Array(frames)
  let offset = 0
  for (const chunk of chunks) {
    audio.set(chunk, offset)
    offset += chunk.length
  }
  return audio
}

/** Native names shown for the language rows. */
const LANGUAGE_LABELS: Readonly<Record<VoiceLanguage, string>> = {
  auto: 'auto',
  ru: 'Русский',
  en: 'English',
  zh: '中文',
}

export const VoiceButton = memo(function VoiceButton({ useInput, inputActions, t }: VoiceButtonProps) {
  const input = useInput(s => s)
  const capable = useMemo(supported, [])
  const [phase, setPhase] = useState<VoicePhase>({ kind: 'idle' })
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS)
  const [panelOpen, setPanelOpen] = useState(false)
  // Value never read; the bump itself re-renders the recording clock.
  const [, setTick] = useState(0)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const workerUrlRef = useRef<string | null>(null)
  const recorderRef = useRef<Recorder | null>(null)
  const seqRef = useRef(0)
  /** Latest session facts for the async worker/recorder callbacks. */
  const liveRef = useRef<{
    draft: string
    busy: boolean
    settings: VoiceSettings
    actions: InputActions
  }>({ draft: '', busy: false, settings: DEFAULT_VOICE_SETTINGS, actions: inputActions })

  useDismissOnOutsidePointer(wrapRef, panelOpen, setPanelOpen)

  // Load the persisted settings once; the defaults hold when storage is absent.
  useEffect(() => {
    setSettings(loadVoiceSettings())
  }, [])

  // The callbacks below resolve session facts at event time through this
  // mirror, so a recognition landing after a session switch edits the draft
  // the mic seat currently shows.
  liveRef.current = {
    draft: input.draft,
    busy: input.phase !== 'plain',
    settings,
    actions: inputActions,
  }

  // Recording clock: one re-render per second while the take runs.
  useEffect(() => {
    if (phase.kind !== 'recording') return
    const timer = window.setInterval(() => { setTick(value => value + 1) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [phase.kind])

  // Failed states clear themselves; the seq keys the timer to each failure.
  useEffect(() => {
    if (phase.kind !== 'failed') return
    const timer = window.setTimeout(() => {
      setPhase(current => current.kind === 'failed' && current.seq === phase.seq ? { kind: 'idle' } : current)
    }, FAILURE_HOLD_MS)
    return () => { window.clearTimeout(timer) }
  }, [phase])

  /** Close the capture graph and stop the microphone tracks. */
  const stopRecorder = useCallback((recorder: Recorder | null): Recorder | null => {
    if (recorder === null) return null
    recorder.node.port.onmessage = null
    recorder.node.disconnect()
    recorder.source.disconnect()
    void recorder.context.close().catch(() => { /* closing is best-effort */ })
    for (const track of recorder.stream.getTracks()) track.stop()
    return null
  }, [])

  // Full teardown on unmount: stop the take, terminate the worker, release
  // the Blob URL (a terminated worker never needs its URL again).
  useEffect(() => () => {
    stopRecorder(recorderRef.current)
    recorderRef.current = null
    workerRef.current?.terminate()
    workerRef.current = null
    if (workerUrlRef.current !== null) {
      URL.revokeObjectURL(workerUrlRef.current)
      workerUrlRef.current = null
    }
  }, [stopRecorder])

  /** Append recognized text to the draft (and submit under auto-send). */
  const deliver = useCallback((text: string) => {
    const live = liveRef.current
    if (text === '' || live.busy) return
    const draft = live.draft
    const glue = draft === '' || /\s$/.test(draft) ? '' : ' '
    live.actions.setDraft(draft + glue + text)
    if (live.settings.autoSend) live.actions.submit()
  }, [])

  /** Worker messages for the current round trip only (seq guards stale answers). */
  const handleWorkerMessage = useCallback((event: MessageEvent) => {
    const message = event.data as {
      type: 'progress' | 'result' | 'error'
      seq: number
      percent?: number
      text?: string
      message?: string
    }
    if (message.seq !== seqRef.current) return
    if (message.type === 'progress') {
      const percent = message.percent
      setPhase(percent === undefined || percent < 100
        ? { kind: 'loading', percent }
        : { kind: 'transcribing' })
      return
    }
    if (message.type === 'result') {
      setPhase({ kind: 'idle' })
      if (typeof message.text === 'string') deliver(message.text)
      return
    }
    setPhase({ kind: 'failed', message: message.message ?? 'unknown error', seq: seqRef.current })
  }, [deliver])

  /** Lazily start the recognition worker (one Blob-module worker per mount). */
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current !== null) return workerRef.current
    const url = URL.createObjectURL(new Blob([WHISPER_WORKER_SOURCE], { type: 'text/javascript' }))
    const worker = new Worker(url, { type: 'module' })
    worker.onmessage = handleWorkerMessage
    worker.onerror = () => {
      setPhase(current => current.kind === 'transcribing' || current.kind === 'loading'
        ? { kind: 'failed', message: 'worker crashed', seq: seqRef.current }
        : current)
    }
    workerRef.current = worker
    workerUrlRef.current = url
    return worker
  }, [handleWorkerMessage])

  /** Finish the take: close capture and hand the audio to the pipeline. */
  const finishRecording = useCallback((recorder: Recorder) => {
    stopRecorder(recorder)
    recorderRef.current = null
    if (recorder.frames < recorder.context.sampleRate / 3) {
      // Under ~1/3 s of audio: nothing worth a pipeline round trip.
      setPhase({ kind: 'idle' })
      return
    }
    seqRef.current += 1
    const live = liveRef.current
    const audio = mergeChunks(recorder.chunks, recorder.frames)
    setPhase({ kind: 'transcribing' })
    ensureWorker().postMessage({
      type: 'transcribe',
      seq: seqRef.current,
      audio,
      model: VOICE_MODELS[live.settings.model].repo,
      language: live.settings.language === 'auto' ? null : live.settings.language,
    }, [audio.buffer])
  }, [ensureWorker, stopRecorder])

  /** Begin capturing: request the mic and wire the 16 kHz worklet tap. */
  const startRecording = useCallback(async () => {
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const context = new AudioContext({ sampleRate: 16000 })
      // The tap module arrives as Blob-source text, registered per take: the
      // AudioContext that consumes it is closed on stop, releasing the module.
      const workletUrl = URL.createObjectURL(new Blob([VOICE_TAP_WORKLET_SOURCE], { type: 'application/javascript' }))
      try {
        await context.audioWorklet.addModule(workletUrl)
      } finally {
        URL.revokeObjectURL(workletUrl)
      }
      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'voice-tap', { numberOfOutputs: 1, outputChannelCount: [1] })
      const recorder: Recorder = {
        stream, context, source, node,
        chunks: [], frames: 0, voicedMs: 0, silentMs: 0,
      }
      const startedAt = Date.now()
      node.port.onmessage = (event) => {
        const channel = event.data as Float32Array
        recorder.chunks.push(channel)
        recorder.frames += channel.length
        let square = 0
        for (let i = 0; i < channel.length; i += 1) {
          const sample = channel[i] ?? 0
          square += sample * sample
        }
        const rms = Math.sqrt(square / Math.max(1, channel.length))
        const windowMs = (channel.length / recorder.context.sampleRate) * 1000
        if (rms >= SILENCE_RMS) {
          recorder.voicedMs += windowMs
          recorder.silentMs = 0
        } else {
          recorder.silentMs += windowMs
        }
        const live = liveRef.current
        if (live.settings.autoSend && recorder.voicedMs >= MIN_VOICED_MS
          && recorder.silentMs >= live.settings.silenceMs) {
          finishRecording(recorder)
          return
        }
        if (Date.now() - startedAt >= MAX_RECORDING_MS) finishRecording(recorder)
      }
      source.connect(node)
      // The worklet keeps one (silent) output so the destination pulls the
      // capture graph; a zero-gain node keeps the monitored audio inaudible.
      const sink = context.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(context.destination)
      recorderRef.current = recorder
      setPhase({ kind: 'recording', since: Date.now() })
      setTick(value => value + 1)
    } catch (error) {
      if (stream !== null) {
        for (const track of stream.getTracks()) track.stop()
      }
      setPhase({
        kind: 'failed',
        message: error instanceof DOMException && error.name === 'NotAllowedError'
          ? t('error.denied')
          : String(error),
        seq: seqRef.current,
      })
    }
  }, [finishRecording, t])

  const onMic = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder !== null) {
      finishRecording(recorder)
      return
    }
    void startRecording()
  }, [finishRecording, startRecording])

  /** One settings field changed: persist and apply in place. */
  const update = useCallback((partial: Partial<VoiceSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...partial }
      saveVoiceSettings(next)
      return next
    })
  }, [])

  const onModelChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    update({ model: event.target.value as VoiceModel })
  }
  const onLanguageChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    update({ language: event.target.value as VoiceLanguage })
  }
  const onSilenceChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    update({ silenceMs: Number(event.target.value) })
  }
  const onAutoSend = (event: ChangeEvent<HTMLInputElement>): void => {
    update({ autoSend: event.target.checked })
  }

  if (!capable) return null

  const busy = phase.kind === 'transcribing' || phase.kind === 'loading'
  const micDisabled = busy || liveRef.current.busy
  const micLabel = phase.kind === 'recording' ? t('mic.stop') : t('mic.start')

  const bubble = ((): string | null => {
    switch (phase.kind) {
      case 'recording': return t('status.recording', { time: elapsedText(Date.now() - phase.since) })
      case 'transcribing': return t('status.transcribing')
      case 'loading': return t('status.model', {
        model: liveRef.current.settings.model,
        percent: phase.percent === undefined ? '…' : String(phase.percent),
      })
      case 'failed': return phase.message
      default: return null
    }
  })()

  return (
    <div className={css.wrap} ref={wrapRef} data-voice-seat>
      {bubble !== null && !panelOpen && (
        <div className={css.bubble} role="status">{bubble}</div>
      )}
      <Tooltip label={micLabel} side="top" delayMs={500}>
        <button
          type="button"
          className={phase.kind === 'recording' ? css.micRecording : css.mic}
          aria-label={micLabel}
          aria-pressed={phase.kind === 'recording'}
          disabled={micDisabled}
          onClick={onMic}
        >
          {busy ? (
            <svg className={css.spin} viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeDasharray="26 9" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <rect x="6" y="1" width="4" height="8" rx="2" fill="currentColor" />
              <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0h-1.6a2.9 2.9 0 0 1-5.8 0Z" fill="currentColor" />
              <rect x="7.25" y="12" width="1.5" height="2.5" fill="currentColor" />
            </svg>
          )}
        </button>
      </Tooltip>
      {phase.kind !== 'recording' && (
        <Tooltip label={t('mic.settings')} side="top" delayMs={500}>
          <button
            type="button"
            className={panelOpen ? css.chevronOpen : css.chevron}
            aria-label={t('mic.settings')}
            aria-expanded={panelOpen}
            aria-haspopup="dialog"
            disabled={busy}
            onClick={() => { setPanelOpen(open => !open) }}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
              <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </Tooltip>
      )}
      {panelOpen && (
        <div className={css.panel} data-voice-panel role="dialog" aria-label={t('settings.title')}>
          <div className={css.panelTitle}>{t('settings.title')}</div>
          <label className={css.row}>
            <span>{t('settings.model')}</span>
            <select value={settings.model} onChange={onModelChange}>
              {(Object.keys(VOICE_MODELS) as VoiceModel[]).map(model => (
                <option key={model} value={model}>
                  {`whisper-${model} · ${String(VOICE_MODELS[model].megabytes)} MB`}
                </option>
              ))}
            </select>
          </label>
          <label className={css.row}>
            <span>{t('settings.language')}</span>
            <select value={settings.language} onChange={onLanguageChange}>
              {(Object.keys(LANGUAGE_LABELS) as VoiceLanguage[]).map(language => (
                <option key={language} value={language}>
                  {language === 'auto' ? t('settings.language.auto') : LANGUAGE_LABELS[language]}
                </option>
              ))}
            </select>
          </label>
          <label className={css.rowCheck}>
            <input type="checkbox" checked={settings.autoSend} onChange={onAutoSend} />
            <span>{t('settings.autoSend')}</span>
          </label>
          <label className={css.row}>
            <span>{t('settings.silence')}</span>
            <select
              value={String(settings.silenceMs)}
              onChange={onSilenceChange}
              disabled={!settings.autoSend}
            >
              {SILENCE_CHOICES.map(choice => (
                <option key={choice} value={String(choice)}>
                  {t('settings.seconds', { n: choice / 1000 })}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )
})
