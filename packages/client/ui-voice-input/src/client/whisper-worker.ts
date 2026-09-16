/**
 * The dictation worker, shipped as source text and started from a Blob URL so
 * the plugin bundle stays dependency-free: the worker itself pulls the
 * transformers.js runtime from the jsDelivr CDN on first use (the browser
 * caches it), then runs the quantized ONNX Whisper pipeline fully locally —
 * audio in, text out, nothing leaves the page afterwards.
 *
 * One worker instance serves the whole plugin; the pipeline is rebuilt only
 * when the requested model changes, and download progress is forwarded so the
 * button can show a percentage during the one-time model fetch.
 */

/** jsDelivr ESM entry of the pinned transformers.js release. */
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1'
/** The worker program. Plain string: no bundle-time transforms apply inside. */
export const WHISPER_WORKER_SOURCE = `
let lib = null
let pipe = null
let pipeModel = null
const filePercents = new Map()

async function runtime() {
  if (lib === null) {
    lib = await import(${JSON.stringify(TRANSFORMERS_CDN)})
    lib.env.allowLocalModels = false
    lib.env.useBrowserCache = true
  }
  return lib
}

self.onmessage = async (event) => {
  const message = event.data
  if (message.type !== 'transcribe') return
  const seq = message.seq
  try {
    const T = await runtime()
    if (pipe === null || pipeModel !== message.model) {
      pipe = await T.pipeline('automatic-speech-recognition', message.model, {
        dtype: 'q8',
        progress_callback: (item) => {
          if (item.status === 'progress' && typeof item.progress === 'number') {
            filePercents.set(item.file, item.progress)
            let total = 0
            for (const percent of filePercents.values()) total += percent
            self.postMessage({
              type: 'progress',
              seq,
              percent: Math.round(total / filePercents.size),
            })
          }
        },
      })
      pipeModel = message.model
      filePercents.clear()
    }
    const output = await pipe(message.audio, {
      task: 'transcribe',
      ...(message.language ? { language: message.language } : {}),
    })
    const text = output && typeof output.text === 'string' ? output.text.trim() : ''
    self.postMessage({ type: 'result', seq, text })
  } catch (error) {
    self.postMessage({
      type: 'error',
      seq,
      message: String(error && error.message ? error.message : error),
    })
  }
}
`

/**
 * The capture worklet, also shipped as source text and registered from a Blob
 * URL: AudioWorklet is the non-deprecated capture path (ScriptProcessor is
 * lint-banned), and it buffers 16 kHz mono frames into ~128 ms blocks so the
 * main thread receives a message rate the silence gate can afford.
 */
export const VOICE_TAP_WORKLET_SOURCE = `
class VoiceTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.filled = 0
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input !== undefined && input.length > 0 ? input[0] : undefined
    if (channel !== undefined) {
      let offset = 0
      while (offset < channel.length) {
        const take = Math.min(channel.length - offset, this.buffer.length - this.filled)
        this.buffer.set(channel.subarray(offset, offset + take), this.filled)
        this.filled += take
        offset += take
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0))
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor('voice-tap', VoiceTapProcessor)
`
