import { useMemo, useRef, useState } from 'react';
import type { FlashcardStudyPreferences, FlashcardWordAction } from '../lib/flashcardPreferences';
import type { WordMemoryState } from '../lib/memoryV2/types';
import { buildWordMemoryDetails } from '../lib/wordMemoryDetails';
import { selectCanonicalMemoryState } from '../lib/memoryV2/wordIdentity';
import { WordMemoryDetailsPanel } from './WordMemoryDetailsPanel';

export function FlashcardWordManager({ words, preferences, busy, onUpdate, memoryStates = [], canonicalWordIds = new Map() }: {
  words: readonly string[];
  preferences: FlashcardStudyPreferences;
  busy: boolean;
  onUpdate: (words: string[], action: FlashcardWordAction) => Promise<void>;
  memoryStates?: readonly WordMemoryState[];
  canonicalWordIds?: ReadonlyMap<string, string>;
}) {
  const [query, setQuery] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updating = useRef(false);
  const [detailWord, setDetailWord] = useState<string | null>(null);
  const stateByWord = useMemo(() => {
    const result = new Map<string, WordMemoryState>();
    for (const state of memoryStates) {
      const word = canonicalWordIds.get(state.wordId) ?? state.wordId;
      const prior = result.get(word);
      result.set(word, selectCanonicalMemoryState(prior ? [prior, state] : [state], word)!);
    }
    return result;
  }, [memoryStates, canonicalWordIds]);
  const matched = useMemo(() => [...new Set(words)]
    .filter(word => word.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => a.localeCompare(b)),
  [words, query]);
  const visible = matched.slice(0, pageSize);
  const allSelected = !!visible.length && visible.every(word => selected.has(word));
  const update = async (action: FlashcardWordAction) => {
    if (busy || updating.current || !selected.size) return;
    updating.current = true;
    setError(null); setMessage(null);
    try {
      const ids = [...selected];
      await onUpdate(ids, action);
      setMessage(`已${{ pause: '暂停', resume: '恢复', remove: '移出' }[action]} ${ids.length} 个词。`);
      setSelected(new Set());
    } catch (cause) { setError(cause instanceof Error ? cause.message : '词表调整失败，请重试。'); }
    finally { updating.current = false; }
  };
  return <section className="flashcard-settings__page flashcard-word-manager">
    <input type="search" aria-label="搜索词表" placeholder="搜索单词" value={query} disabled={busy}
      onChange={event => { setQuery(event.target.value); setPageSize(100); }} />
    <div className="flashcard-word-manager__selection">
      <label><input type="checkbox" checked={allSelected} disabled={busy || !visible.length}
        onChange={() => setSelected(previous => { const next = new Set(previous); visible.forEach(word => allSelected ? next.delete(word) : next.add(word)); return next; })} />选择本页</label>
      <span>{selected.size ? `已选 ${selected.size} 个` : `${matched.length} 个词`}</span>
    </div>
    <div className="flashcard-word-manager__actions" aria-label="批量管理单词">
      <button type="button" disabled={busy || !selected.size} onClick={() => void update('pause')}>暂停</button>
      <button type="button" disabled={busy || !selected.size} onClick={() => void update('resume')}>恢复</button>
      <button type="button" disabled={busy || !selected.size} onClick={() => void update('remove')}>移出词卡</button>
    </div>
    {error && <p className="flashcard-settings__error" role="alert">{error}</p>}
    {message && <p className="flashcard-settings__note" role="status">{message}</p>}
    <ul className="flashcard-word-manager__list">{visible.map(word => {
      const details = buildWordMemoryDetails(stateByWord.get(word) ?? null, preferences, new Date(), word);
      return <li key={word}>
      <div className="flashcard-word-manager__row">
      <label><input type="checkbox" checked={selected.has(word)} disabled={busy} onChange={() => setSelected(previous => {
        const next = new Set(previous); if (next.has(word)) next.delete(word); else next.add(word); return next;
      })} /><span lang="en">{word}</span><small data-status={details.status}>{details.statusLabel}</small></label>
      <button type="button" disabled={busy} className="flashcard-word-manager__detail" aria-label={`查看 ${word} 的记忆记录`} aria-expanded={detailWord === word}
        onClick={() => setDetailWord(value => value === word ? null : word)}>记录</button>
      </div>
      {detailWord === word && <WordMemoryDetailsPanel key={word} wordId={word} initiallyOpen />}
    </li>;
    })}</ul>
    {!matched.length && <p className="flashcard-settings__note">{query ? '没有找到匹配的单词。' : '阅读查词或导入词表后，可在这里管理。'}</p>}
    {matched.length > pageSize && <button type="button" className="flashcard-word-manager__more" disabled={busy} onClick={() => setPageSize(size => size + 100)}>显示更多</button>}
    <p className="flashcard-settings__note">暂停或移出会停止词卡安排，历史学习记录保留，可随时恢复。</p>
  </section>;
}
