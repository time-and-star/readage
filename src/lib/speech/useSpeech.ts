import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';
import { getSpeechSnapshot, prepareSpeech, setSpeechPreferences, speakText, stopSpeech, subscribeSpeech, type SpeechTarget } from './index';
import { speakRepeatedText } from './repeat';

/** Shared preferences, with playback and errors owned by the component using this hook. */
export function useSpeech(language?: string) {
  const scope = useId();
  const snapshot = useSyncExternalStore(subscribeSpeech, getSpeechSnapshot, getSpeechSnapshot);
  useEffect(() => () => stopSpeech(scope), [scope]);
  const state = snapshot.state.scope === scope ? snapshot.state : { status: 'idle' as const };
  const speak = useCallback((text: string, target?: SpeechTarget) => {
    void speakText(text, { scope, target, lang: language }).catch(() => { /* The accessible UI renders the published error. */ });
  }, [scope, language]);
  const speakRepeated = useCallback(async (text: string, count: number, target?: SpeechTarget, signal?: AbortSignal) => {
    await speakRepeatedText(text, count,
      value => speakText(value, { scope, target, lang: language }), signal);
  }, [scope, language]);
  const stop = useCallback(() => stopSpeech(scope), [scope]);
  const prepare = useCallback((text: string) => prepareSpeech(text, { scope, lang: language }), [scope, language]);
  return {
    scope,
    preferences: snapshot.preferences,
    state,
    setPreferences: setSpeechPreferences,
    speak,
    speakRepeated,
    stop,
    prepare,
  };
}
