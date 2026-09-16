/**
 * Voice input plugin, browser half: occupies the composer's
 * `conversation.input.left` list slot with the local dictation mic seat. The
 * registration waits until ui-conversation declares the slot, registers the
 * `voice` dictionaries for the framework-synthesized translate seat, and
 * contributes no host-plane behavior — recognition runs entirely in the
 * browser (see VoiceButton and the Blob-module Whisper worker).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { VoiceButton } from './VoiceButton.tsx'
import { en, zh, type VoiceKey } from './locales.ts'

export { VoiceButton } from './VoiceButton.tsx'
export type { VoiceButtonProps } from './VoiceButton.tsx'
export type { VoiceKey } from './locales.ts'
export {
  DEFAULT_VOICE_SETTINGS, SILENCE_CHOICES, VOICE_MODELS,
  loadVoiceSettings, saveVoiceSettings,
  type VoiceLanguage, type VoiceModel, type VoiceSettings,
} from './settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer voice seat's copy. */
    voice: VoiceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'voice'

/** Required services: the seat's slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the `voice` dictionaries, then contribute the
 * mic seat into the conversation-declared `conversation.input.left` list.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-input: dictionaries')

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-input',
    locale: NS,
  }, VoiceButton))
}
