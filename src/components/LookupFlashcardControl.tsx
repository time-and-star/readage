import { useEffect, useRef, useState, useSyncExternalStore, type FC } from 'react';
import type { LearningTermRef } from '../../packages/dictionary/contracts';
import { resolveDictionaryLearningWordId } from '../lib/dictionaryClient';
import { isLookupFlashcardExcluded, updateLookupFlashcardEnrollment } from '../lib/lookupFlashcardEnrollment';
import { useMemoryStore } from '../lib/memoryV2/MemoryProvider';

interface Props { selectedText: string; learningTermRef?: LearningTermRef }
interface EnrollmentView { wordId: string; excluded: boolean }

/** Enrollment is separate from lookup evidence: removing a card never erases learning history. */
export const LookupFlashcardControl: FC<Props> = ({ selectedText, learningTermRef }) => {
  const store = useMemoryStore();
  const activityVersion = useSyncExternalStore(store.subscribe,
    () => store.getSnapshot().activityVersion, () => store.getSnapshot().activityVersion);
  const [view, setView] = useState<EnrollmentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<boolean | null>(null);
  const [readRetry, setReadRetry] = useState(0);
  const writing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    if (!writing.current) setLoading(true);
    void (async () => {
      await store.ensureReady();
      const wordId = await resolveDictionaryLearningWordId(selectedText, learningTermRef);
      const preferences = await store.system.getFlashcardStudyPreferences(store.userId);
      const excluded = await isLookupFlashcardExcluded(wordId, selectedText, preferences);
      if (active) {
        setView({ wordId, excluded });
        setLoading(false);
      }
    })().catch(() => {
      if (active) { setLoading(false); setError('词卡设置暂时无法读取，请重试。'); }
    });
    return () => { active = false; };
  }, [store, selectedText, learningTermRef?.stableId, activityVersion, readRetry]);

  const update = async (excluded: boolean) => {
    if (!view || writing.current) return;
    writing.current = true;
    setSaving(true); setError(null); setFailedAction(null);
    try {
      const preferences = await updateLookupFlashcardEnrollment(store, view.wordId, selectedText, excluded);
      if (mounted.current) setView({ wordId: view.wordId, excluded: preferences.excludedWordIds?.includes(view.wordId) ?? false });
    } catch {
      if (mounted.current) {
        setError('词卡选择尚未保存，请重试。');
        setFailedAction(excluded);
      }
    } finally {
      writing.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return <div className="lookup-flashcard-control" data-lookup-enrollment-word={view?.wordId} aria-busy={loading || saving}>
    <p role={error ? 'alert' : 'status'}>{error || (saving ? '正在保存词卡选择…' : loading ? '读取词卡设置…'
      : view?.excluded ? '已不收录 · 后续查词也会跳过' : '自动收录到词卡')}</p>
    {error ? <button type="button" disabled={loading || saving} onClick={() => {
      if (failedAction !== null) void update(failedAction);
      else { setError(null); setReadRetry(value => value + 1); }
    }}>{failedAction !== null ? '重试保存' : '重试读取'}</button>
      : <button type="button" disabled={loading || saving || !view} onClick={() => { if (view) void update(!view.excluded); }}>
        {view?.excluded ? '重新收录' : '不收录此词'}
      </button>}
  </div>;
};
