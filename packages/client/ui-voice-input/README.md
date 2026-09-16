---
description: "Local voice dictation for the Web GUI composer: a mic seat that transcribes speech to the draft through an in-browser WASM Whisper pipeline."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-voice-input

## Summary

This package adds voice dictation to the Web GUI composer. It occupies the composer's `conversation.input.left` list slot with a mic button: click to record, click again to transcribe, and the recognized text lands in the composer draft. Recognition runs entirely in the browser — a Web Worker pulls the transformers.js runtime and a quantized ONNX Whisper checkpoint from the CDN once, caches both, and every later utterance stays fully local (audio in, text out, nothing crosses to the Host).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin alongside `ui-conversation` (the web roster already does). A mic button appears to the right of the composer's `+` control whenever the browser exposes microphone capture.

- **Dictate** — click the mic, speak, click again: the transcript appends to the draft for review before sending.
- **Auto-send** — open the chevron beside the mic, enable "Send automatically after silence", and choose the silence length (0.5–5 s): once speech is detected and the mic hears silence that long, the take transcribes and submits itself.
- **Model** — `whisper-tiny` (~40 MB), `whisper-base` (~80 MB), or `whisper-small` (~250 MB), quantized; the first use downloads and caches the checkpoint in the browser.
- **Language** — auto-detect, Russian, English, or Chinese.

Microphone permission is requested on the first recording; a denial surfaces as a transient bubble beside the composer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin is a pure client-surface contributor: the node half is an intentional no-op, and the browser half registers one list entry plus the `voice` locale dictionaries. `VoiceButton` owns a four-state phase machine (idle / recording / transcribing / failed, with a loading state for the one-time model fetch), captures 16 kHz mono through `getUserMedia` + `AudioContext`, and detects silence by RMS for the auto-send gate. `WHISPER_WORKER_SOURCE` is the worker shipped as text and started from a Blob URL, so the bundle stays dependency-free; the worker dynamically imports the pinned `@huggingface/transformers` from jsDelivr, caches the pipeline per model, and reports download progress. Recognized text appends through the standard `inputActions.setDraft` seat (submitting through `inputActions.submit()` under auto-send), so the composer machine keeps full authority over the draft.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **First use needs the network** — the runtime and checkpoint download from the CDN once; afterwards the browser cache serves them offline.
- **No interim results** — Whisper transcribes after the take ends; a CPU may need a few seconds for long utterances (recordings cap at two minutes).
- **Single-threaded WASM** — without cross-origin isolation SharedArrayBuffer is unavailable, so inference is single-threaded; WebGPU is a future option.
- **Safari resampling** — older Safari builds may ignore the 16 kHz capture rate; Chrome and Edge are the supported targets.
