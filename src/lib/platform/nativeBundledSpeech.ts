import { registerPlugin } from '@capacitor/core';
import { createNativeSpeechAdapter, type NativeSpeechPlugin } from './nativeSpeech';

/** Position boxes follow the native audio clock; word locations are estimated within each synthesized segment. */
export const nativeBundledSpeechAdapter = createNativeSpeechAdapter(
  registerPlugin<NativeSpeechPlugin>('ReadageBundledSpeech'),
  { maxTextLength: 20_000, prepare: true, estimatedTimings: true },
);
