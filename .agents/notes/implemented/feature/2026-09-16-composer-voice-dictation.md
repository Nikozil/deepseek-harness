# Agent Note: Composer-local voice dictation mic seat

Status: implemented

English | [中文](2026-09-16-composer-voice-dictation.zh.md)

## Problem

The Web GUI composer accepted typed input only. The standard recognition routes conflict with the client stack's privacy rule that audio never reaches the Host: the Web Speech API uploads microphone audio to the browser vendor's speech service, and a Host-side transcription path would move raw audio across the dsh wire and grow a host-plane service for what is only a composer draft.

## Decision

`packages/client/ui-voice-input` adds a mic seat to the composer as a pure client-surface plugin. The browser half waits on ui-conversation's `conversation.input.left` list declaration through `ctx.slots.inject`, registers the `voice` locale dictionaries, and mounts `VoiceButton`; the node half is an intentional no-op.

Recognition runs entirely in the browser. `getUserMedia` plus an `AudioContext` capture 16 kHz mono through an AudioWorklet tap shipped as source text, and a module Worker started from a Blob URL dynamically imports the pinned `@huggingface/transformers@3.8.1` from jsDelivr and runs the quantized ONNX Whisper checkpoints (`Xenova/whisper-tiny`/`-base`/`-small`) with the browser cache serving later runs. Shipping both the tap and the worker as source text keeps the plugin bundle dependency-free. An RMS silence gate ends auto-send takes: after at least 300 ms of detected speech, trailing silence beyond the configured window (selectable 0.5–5 s, persisted values clamped to 0.3–10 s) stops and transcribes the take, with a two-minute hard cap. The transcript appends to the draft through `inputActions.setDraft` and submits through `inputActions.submit()` under auto-send, so the composer machine keeps draft authority and nothing becomes model-visible outside the normal send path; no session event is added. Model, language, auto-send, and silence preferences persist in localStorage under `dsh.ui-voice-input`, field-clamped on load.

## Alternatives considered

**Web Speech API (`SpeechRecognition`).** Rejected: Chrome implements it by sending audio to Google's speech service, other engines are absent or inconsistent, and a dictation seat that keeps audio local cannot depend on either.

**Host-side or server-side Whisper.** Rejected for this capability: raw audio would reach the Host process, and the feature would grow a host service, transport, and persistence surface to produce a draft edit the client can produce alone.

**Bundling transformers.js as a package dependency.** Rejected: the runtime and its ONNX toolchain would bloat the dynamic client bundle and add module-graph rows for a library used only inside the worker. The pinned CDN import keeps the bundle dependency-free; the trade-off is a one-time network fetch on first use.

**A trained voice-activity model such as Silero VAD.** Rejected: the RMS gate already separates speech from trailing silence for push-to-talk and auto-send, and a second model would double the first-use download.

## Consequences

First use needs the network for the runtime and checkpoint; the browser cache serves later runs. Inference is single-threaded WASM without cross-origin isolation, so long takes transcribe slowly, and transcription produces no interim results. The worker ships as source text, so the package spec pins its source and covers the slot lifecycle, locale dictionaries, and settings round trip; real transcription requires a browser, a microphone, and the CDN, and stays outside automated coverage.
