import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';
import { getSpeechSnapshot, prepareSpeech, setSpeechPreferences, speakText, stopSpeech, subscribeSpeech, type SpeechTarget } from './index';

/** Shared preferences, with playback and errors owned by the component using this hook. */
export function useSpeech() {
  const scope = useId();
  const snapshot = useSyncExternalStore(subscribeSpeech, getSpeechSnapshot, getSpeechSnapshot);
  useEffect(() => () => stopSpeech(scope), [scope]);
  const state = snapshot.state.scope === scope ? snapshot.state : { status: 'idle' as const };
  const speak = useCallback((text: string, target?: SpeechTarget) => {
    void speakText(text, { scope, target }).catch(() => { /* The accessible UI renders the published error. */ });
  }, [scope]);
  const stop = useCallback(() => stopSpeech(scope), [scope]);
  const prepare = useCallback((text: string) => prepareSpeech(text, { scope }), [scope]);
  return {
    scope,
    preferences: snapshot.preferences,
    state,
    setPreferences: setSpeechPreferences,
    speak,
    stop,
    prepare,
  };
}
