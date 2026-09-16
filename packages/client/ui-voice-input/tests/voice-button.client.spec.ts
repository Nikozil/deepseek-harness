/**
 * ui-voice-input browser half on a real SlotRegistry: the plugin waits for
 * ui-conversation to declare the `conversation.input.left` list seat, then
 * occupies it with the mic button under the `voice-input` list id; the `voice`
 * dictionaries register through the real LocaleRuntime; teardown empties the
 * seat (HMR safety). The settings round-trip covers the localStorage store.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { VoiceButton } from '../src/client/VoiceButton.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import {
  DEFAULT_VOICE_SETTINGS, SILENCE_CHOICES, loadVoiceSettings, saveVoiceSettings,
} from '../src/client/settings.ts'
import { WHISPER_WORKER_SOURCE } from '../src/client/whisper-worker.ts'

/** A Map-backed storage double for the settings round trip. */
function fakeStorage(): Storage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
    key: () => null,
    get length() { return map.size },
  }
}

describe('ui-voice-input browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('waits until conversation declares the left list seat', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(0)
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.input.left': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(1)
  })

  it('registers the mic seat, ships both dictionaries, and unregisters on teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.input.left': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = ctx.slots.entries('conversation.input.left')[0]!
    expect(entry.component).toBe(VoiceButton)
    expect(entry.options.id).toBe('voice-input')
    expect(entry.locale).toBe('voice')

    // The dictionary registration landed: the bound translate resolves the
    // active locale's line (en fallback here), and the zh switch resolves too.
    expect(locale.bind('voice')('mic.start')).toBe('Voice input (click to start, click again to stop)')
    locale.setLocale('zh')
    expect(locale.bind('voice')('mic.start')).toContain('语音输入')
    locale.setLocale('en')

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(0)
  })
})

describe('voice settings store', () => {
  it('defaults cleanly without a storage backend', () => {
    expect(loadVoiceSettings(undefined)).toEqual(DEFAULT_VOICE_SETTINGS)
  })

  it('round-trips and clamps out-of-domain fields', () => {
    const store = fakeStorage()
    expect(loadVoiceSettings(store)).toEqual(DEFAULT_VOICE_SETTINGS)

    saveVoiceSettings({ model: 'small', language: 'ru', autoSend: true, silenceMs: 2500 }, store)
    expect(loadVoiceSettings(store)).toEqual({ model: 'small', language: 'ru', autoSend: true, silenceMs: 2500 })

    store.map.set('dsh.ui-voice-input', JSON.stringify({ model: 'enormous', silenceMs: 99_999, extra: true }))
    expect(loadVoiceSettings(store)).toEqual({
      model: DEFAULT_VOICE_SETTINGS.model,
      language: DEFAULT_VOICE_SETTINGS.language,
      autoSend: DEFAULT_VOICE_SETTINGS.autoSend,
      silenceMs: 10_000,
    })

    store.map.set('dsh.ui-voice-input', '{not json')
    expect(loadVoiceSettings(store)).toEqual(DEFAULT_VOICE_SETTINGS)
  })

  it('keeps the silence choices inside the clamped window', () => {
    expect(SILENCE_CHOICES.length).toBeGreaterThan(0)
    for (const choice of SILENCE_CHOICES) {
      expect(choice).toBeGreaterThanOrEqual(300)
      expect(choice).toBeLessThanOrEqual(10_000)
    }
  })
})

describe('whisper worker source', () => {
  it('imports the pinned transformers release and answers the transcribe verb', () => {
    expect(WHISPER_WORKER_SOURCE).toContain('@huggingface/transformers@3.8.1')
    expect(WHISPER_WORKER_SOURCE).toContain("message.type !== 'transcribe'")
    expect(WHISPER_WORKER_SOURCE).toContain("type: 'result'")
  })
})
