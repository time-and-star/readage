import { useEffect, useState } from 'react';
import { resolveLearningWordIds } from './dictionaryClient';
import { useMemorySystem } from './memoryV2/hooks';
import { useMemoryStore } from './memoryV2/MemoryProvider';
import { buildWordMemoryDetails, selectWordMemoryState } from './wordMemoryDetails';

export function useWordMemoryDetails(wordId: string, enabled: boolean) {
  const { ready, version } = useMemorySystem();
  const store = useMemoryStore();
  const [details, setDetails] = useState<ReturnType<typeof buildWordMemoryDetails> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled || !wordId.trim() || !ready) { setDetails(null); setLoading(enabled); return; }
    let active = true;
    setLoading(true);
    setError(null);
    setDetails(null);
    void (async () => {
      try {
        const [states, preferences] = await Promise.all([
          store.system.getReadingVerificationMemoryStates(store.userId),
          store.system.getFlashcardStudyPreferences(store.userId),
        ]);
        const preferenceIds = [...preferences.importedWordIds, ...(preferences.pausedWordIds ?? []), ...(preferences.excludedWordIds ?? [])];
        const words = [wordId, ...states.map(state => state.wordId), ...preferenceIds];
        let ids: string[];
        let resolverTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          ids = await Promise.race([
            resolveLearningWordIds(words),
            new Promise<never>((_, reject) => { resolverTimer = setTimeout(() => reject(new Error('Word identity lookup timed out')), 5000); }),
          ]);
        } catch { ids = words.map(word => word.trim().toLowerCase()); }
        finally { if (resolverTimer) clearTimeout(resolverTimer); }
        const canonical = ids[0] || wordId;
        const state = selectWordMemoryState(states, ids.slice(1, 1 + states.length), canonical);
        const preferenceMap = new Map(preferenceIds.map((id, index) => [id, ids[1 + states.length + index] || id]));
        const canonicalPreferences = {
          ...preferences,
          importedWordIds: preferences.importedWordIds.map(id => preferenceMap.get(id) || id),
          pausedWordIds: preferences.pausedWordIds?.map(id => preferenceMap.get(id) || id),
          excludedWordIds: preferences.excludedWordIds?.map(id => preferenceMap.get(id) || id),
        };
        if (active) setDetails(buildWordMemoryDetails(state, canonicalPreferences, new Date(), canonical));
      } catch {
        if (active) setError('记忆记录暂未加载，请重试。');
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [store, ready, version, wordId, enabled, retry]);
  return { details, loading: loading || !ready, error: error ?? store.getSnapshot().lifecycleError, timezone: store.timezone,
    retry: () => {
      setError(null);
      if (!ready) void store.start().catch(() => undefined);
      else setRetry(value => value + 1);
    } };
}
