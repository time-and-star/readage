import { useEffect, useState } from 'react';
import type { LearningEvent } from '../types';
import type { ArticleWordEvidence } from './memoryV2/types';
import { useMemorySystem } from './memoryV2/hooks';
import { resolveLearningWordIds } from './dictionaryClient';
import { toLemma } from './proficiency.legacy';

export function useReadingStudyEvidence(events: LearningEvent[], enabled: boolean) {
  const { memorySystem, userId, ready, version } = useMemorySystem();
  const [evidence, setEvidence] = useState<ArticleWordEvidence[]>([]);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    let active = true;
    if (!enabled || !ready) return;
    setLoading(true);
    void (async () => {
      try {
        const rows = await memorySystem.getArticleLearningEvidence(userId);
        const words = [...new Set([
          ...rows.map(row => toLemma(row.wordId)),
          ...events.filter(event => event.articleId && ['click', 'grammar_query', 'add_review'].includes(event.type))
            .map(event => toLemma(event.lemma ?? '')),
        ].filter(Boolean))];
        let mapping: Record<string, string> = {};
        try {
          const ids = await resolveLearningWordIds(words);
          mapping = Object.fromEntries(words.map((word, index) => [word, ids[index]]));
        } catch { /* Saved word IDs remain readable while the dictionary is unavailable. */ }
        if (active) { setEvidence(rows); setAliases(mapping); setError(null); }
      } catch {
        if (active) setError('生词记录暂未完整加载，请重试。');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [memorySystem, userId, ready, version, events, enabled, retryCount]);
  return { evidence, aliases, loading: loading || !ready, error, retry: () => setRetryCount(count => count + 1) };
}
