import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Sparkles, X } from 'lucide-react';
import type { GrammarExplanation } from '../types';
import { createDictionaryClient, resolveDictionaryLearningWordId } from '../lib/dictionaryClient';
import type { LookupResult } from '../../packages/dictionary/contracts';
import { saveLookupEvidenceOnce, type LookupEvidenceState } from '../lib/lookupEvidence';
import { createWordCardRequest, fetchWordCard } from '../lib/wordCard';
import { useMemorySystem } from '../lib/memoryV2/hooks';
import { useSpeech } from '../lib/speech/useSpeech';
import { SpeechFeedback } from './SpeechControls';

const loadWordCardPanel = () => import('./WordCardPanel').then(module => ({ default: module.WordCardPanel }));
const WordCardPanel = lazy(loadWordCardPanel);

function WordSearchCardLoading({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div className="word-card-backdrop" role="dialog" aria-modal="true" aria-label="Word card"
    style={{ zIndex: 60 }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="word-card-dialog" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') { event.preventDefault(); closeRef.current?.focus(); }
    }}>
      <div className="word-card-dialog__bar"><span className="word-card-dialog__label">Dictionary lookup</span>
        <button type="button" className="word-card-icon-button" ref={closeRef} aria-label="Close word card" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="word-card-state" aria-busy="true">
        <div className="word-card-state__icon"><Sparkles className="h-5 w-5 animate-pulse" /></div>
        <p className="word-card-state__title">Looking up</p>
        <p className="word-card-state__copy">Querying the enabled local dictionaries.</p>
      </div>
    </div>
  </div>, document.body);
}

export function normalizeWordSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80);
}

export async function recordWordSearchEvidence(
  wordId: string,
  query: string,
  recordExposure: (wordId: string, articleId: string, occurrenceId: string, signals: { contextText: string }) => Promise<void>,
  recordClick: (wordId: string, articleId: string, occurrenceId: string) => Promise<void>,
  now = Date.now(),
  occurrenceId = `search:${wordId}:${now}`,
): Promise<void> {
  await recordExposure(wordId, 'word-search', occurrenceId, {
    contextText: `Word search: ${query}`,
  });
  await recordClick(wordId, 'word-search', occurrenceId);
}

export const WordSearchModule: React.FC = () => {
  const [language, setLanguage] = useState('en');
  const speech = useSpeech(language === 'en' ? undefined : language);
  const [searchOpen, setSearchOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GrammarExplanation | null>(null);
  const [neutralResult, setNeutralResult] = useState<LookupResult | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ message: string; retry?: () => void } | null>(null);
  const evidenceRef = useRef<{ query: string; occurrenceId: string; state: LookupEvidenceState } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { recordExposure, recordClick } = useMemorySystem();

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    // Prepare the card while the reader types, without adding its NLP model to page startup.
    if (searchOpen) void loadWordCardPanel().catch(() => {});
  }, [searchOpen]);
  const speechPreparationText = result?.wordOrPhrase || selectedText;
  useEffect(() => {
    if (!cardOpen || !speechPreparationText) return;
    let cancel: (() => void) | undefined;
    const timer = setTimeout(() => { cancel = speech.prepare(speechPreparationText); }, 150);
    return () => { clearTimeout(timer); cancel?.(); };
  }, [cardOpen, speechPreparationText, speech.prepare, speech.preferences.lang, speech.preferences.rate]);

  const search = async (event?: React.FormEvent, requestedQuery = query, recordEvidence = true) => {
    event?.preventDefault();
    const normalized = normalizeWordSearchQuery(requestedQuery);
    const request = language === 'en' ? createWordCardRequest(normalized) : normalized ? { selectedText: normalized, contextSentence: '' } : null;
    if (!request) return;
    abortRef.current?.abort();
    speech.stop();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearchOpen(false);
    setCardOpen(true);
    setSelectedText(request.selectedText);
    setLoading(true);
    setResult(null);
    setNeutralResult(null);
    setSaveFeedback(null);
    setError(null);
    try {
      if (language !== 'en') {
        const value = await createDictionaryClient().lookup({ text: request.selectedText, language, preferredDefinitionLanguages: ['zh', language, 'en'] }, controller.signal);
        if (!controller.signal.aborted) setNeutralResult(value);
        return;
      }
      const card = await fetchWordCard(request, { signal: controller.signal, forceRefresh: !recordEvidence });
      if (controller.signal.aborted) return;
      setResult(card);
      setLoading(false);
      const evidence = !recordEvidence && evidenceRef.current?.query === request.selectedText ? evidenceRef.current
        : { query: request.selectedText, occurrenceId: `search:${crypto.randomUUID()}`, state: { saved: false } };
      evidenceRef.current = evidence;
      const save = async () => {
        if (controller.signal.aborted) return;
        setSaveFeedback({ message: evidence.state.saved ? '学习记录已保存' : '正在保存学习记录…' });
        try {
          await saveLookupEvidenceOnce(evidence.state, async () => {
            const wordId = await resolveDictionaryLearningWordId(request.selectedText, card.learningTermRef);
            controller.signal.throwIfAborted();
            await recordWordSearchEvidence(wordId, request.selectedText, recordExposure, recordClick, undefined, evidence.occurrenceId);
          });
          if (!controller.signal.aborted) setSaveFeedback({ message: '学习记录已保存' });
        } catch {
          if (!controller.signal.aborted) setSaveFeedback({ message: '释义已显示，学习记录待保存', retry: () => { void save(); } });
        }
      };
      await save();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Word search failed.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const refreshRef = useRef(() => {});
  refreshRef.current = () => { void search(undefined, selectedText, false); };
  useEffect(() => {
    if (!cardOpen) return;
    const refresh = () => refreshRef.current();
    window.addEventListener('dictionary-settings-changed', refresh);
    return () => window.removeEventListener('dictionary-settings-changed', refresh);
  }, [cardOpen]);

  const close = () => {
    speech.stop();
    abortRef.current?.abort();
    setSearchOpen(false);
    setCardOpen(false);
    setLoading(false);
    setError(null);
    setSaveFeedback(null);
  };

  useEffect(() => {
    if (!searchOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [searchOpen]);

  return (
    <>
      <button
        type="button"
        className="tap-target inline-flex items-center justify-center rounded-xl p-2.5 text-[#524B43] transition-colors hover:bg-[#EFEAE0]"
        aria-label="Search a word"
        title="Search a word"
        onClick={() => setSearchOpen(true)}
      >
        <Search className="h-5 w-5" aria-hidden="true" />
      </button>
      {searchOpen && (
        <div
          className="word-search-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Search a word"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <form className="word-search-form" onSubmit={search}>
            <label className="mb-3 flex items-center gap-2 text-sm">查询语言
              <select aria-label="查询语言" value={language} onChange={event => {
                abortRef.current?.abort(); speech.stop(); setLanguage(event.target.value);
                setSelectedText(''); setResult(null); setNeutralResult(null); setCardOpen(false); setLoading(false); setError(null); setSaveFeedback(null);
              }}>
                <option value="en">英语</option><option value="fr">法语</option><option value="ja">日语</option>
              </select>
            </label>
            <div className="word-search-form__bar">
              <Search className="h-5 w-5 shrink-0 text-[#8E857A]" aria-hidden="true" />
              <label className="sr-only" htmlFor="word-search-input">Search a word</label>
              <input
                id="word-search-input"
                autoFocus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={language === 'fr' ? '输入法语词或短语' : language === 'ja' ? '输入日语词或短语' : 'Search an English word or phrase'}
                className="min-w-0 flex-1 bg-transparent text-base text-[#2B2723] outline-none"
                enterKeyHint="search"
              />
              <button type="button" className="word-search-close" aria-label="Close word search" onClick={close}>
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <button type="submit" className="word-search-submit" disabled={!normalizeWordSearchQuery(query)}>
              {loading ? 'Searching...' : 'Search'}
            </button>
            {error && <p className="word-search-error" role="alert">{error}</p>}
          </form>
        </div>
      )}
      {cardOpen && <Suspense fallback={<WordSearchCardLoading onClose={close} />}><WordCardPanel
        open={cardOpen}
        loading={loading}
        result={result}
        neutralResult={neutralResult}
        recordStatus={saveFeedback?.message}
        onRetryRecord={saveFeedback?.retry}
        error={error}
        selectedText={selectedText}
        onClose={close}
        onSpeak={speech.speak}
        onStopSpeech={speech.stop}
        onRetrySources={() => { void search(undefined, selectedText, false); }}
        onLookupRelated={(word) => {
          setQuery(word);
          void search(undefined, word);
        }}
      /></Suspense>}
      <SpeechFeedback state={speech.state} onStop={speech.stop} floating />
    </>
  );
};
