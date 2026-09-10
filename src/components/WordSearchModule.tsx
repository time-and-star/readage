import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { GrammarExplanation } from '../types';
import { lookupDictionaryWord, toDictionaryWordCard as toWordCardResult } from '../lib/dictionaryClient';
import { useMemorySystem } from '../lib/memoryV2/hooks';
import { WordCardPanel } from './WordCardPanel';

export function normalizeWordSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80);
}

export async function recordWordSearchEvidence(
  wordId: string,
  query: string,
  recordExposure: (wordId: string, articleId: string, occurrenceId: string, signals: { contextText: string }) => Promise<void>,
  recordClick: (wordId: string, articleId: string, occurrenceId: string) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  const occurrenceId = `search:${wordId}:${now}`;
  await recordExposure(wordId, 'word-search', occurrenceId, {
    contextText: `Word search: ${query}`,
  });
  await recordClick(wordId, 'word-search', occurrenceId);
}

export const WordSearchModule: React.FC = () => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GrammarExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { recordExposure, recordClick } = useMemorySystem();

  useEffect(() => () => abortRef.current?.abort(), []);

  const search = async (event?: React.FormEvent, requestedQuery = query) => {
    event?.preventDefault();
    const normalized = normalizeWordSearchQuery(requestedQuery);
    if (!normalized || loading) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearchOpen(false);
    setCardOpen(true);
    setSelectedText(normalized);
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const entry = await lookupDictionaryWord(normalized, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (entry) {
        const wordId = (entry.lemma || normalized).toLowerCase();
        setResult(toWordCardResult(entry));
        try {
          await recordWordSearchEvidence(wordId, normalized, recordExposure, recordClick);
        } catch (memoryError) {
          console.error('Failed to record word search evidence:', memoryError);
        }
      }
    } catch (cause) {
      if (cause instanceof Error && /abort|cancel/i.test(cause.message)) return;
      setCardOpen(false);
      setSearchOpen(true);
      setError(cause instanceof Error ? cause.message : 'Word search failed.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const close = () => {
    abortRef.current?.abort();
    setSearchOpen(false);
    setCardOpen(false);
    setLoading(false);
    setError(null);
  };

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
            <div className="word-search-form__bar">
              <Search className="h-5 w-5 shrink-0 text-[#8E857A]" aria-hidden="true" />
              <label className="sr-only" htmlFor="word-search-input">Search a word</label>
              <input
                id="word-search-input"
                autoFocus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search an English word"
                className="min-w-0 flex-1 bg-transparent text-base text-[#2B2723] outline-none"
                enterKeyHint="search"
              />
              <button type="button" className="word-search-close" aria-label="Close word search" onClick={close}>
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <button type="submit" className="word-search-submit" disabled={!normalizeWordSearchQuery(query) || loading}>
              {loading ? 'Searching...' : 'Search'}
            </button>
            {error && <p className="word-search-error" role="alert">{error}</p>}
          </form>
        </div>
      )}
      <WordCardPanel
        open={cardOpen && (loading || Boolean(result) || Boolean(selectedText && !error))}
        loading={loading}
        result={result}
        selectedText={selectedText}
        onClose={close}
        onSpeak={(text) => window.speechSynthesis?.speak(new SpeechSynthesisUtterance(text))}
        onLookupRelated={(word) => {
          setQuery(word);
          void search(undefined, word);
        }}
      />
    </>
  );
};
