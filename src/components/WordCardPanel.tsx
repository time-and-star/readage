import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Copy, Globe, Sparkles, Volume2, X } from 'lucide-react';
import type { GrammarExplanation } from '../types';
import { DictionarySenseGroups } from './DictionarySenseGroups';
import { DictionarySourceSections } from './DictionarySourceSections';
import { DictionarySourceIssues } from './DictionarySourceIssues';
import { WordCardInteractions } from './WordCardInteractions';
import { WordCardText } from './WordCardText';
import { isTopWordCard } from '../lib/wordCardInteractions';
import { WordMemoryDetailsPanel } from './WordMemoryDetailsPanel';

export interface WordCardPanelProps {
  open: boolean;
  loading: boolean;
  result: GrammarExplanation | null;
  /** Selected lookup text (for translate/copy actions while loading or after). */
  selectedText?: string;
  onClose: () => void;
  onSpeak: (text: string) => void;
  onLookupRelated: (word: string) => void;
  onTranslate?: () => void;
  onCopy?: () => void;
  onRetrySources?: () => void;
  error?: string | null;
  ancestorCardIds?: string[];
}

/**
 * Independent word-card drawer for local dictionary entries.
 * Portaled to document.body so the translated reading root cannot clip it.
 */
export const WordCardPanel: React.FC<WordCardPanelProps> = ({
  open,
  loading,
  result,
  selectedText,
  onClose,
  onSpeak,
  onLookupRelated,
  onTranslate,
  onCopy,
  onRetrySources,
  error,
  ancestorCardIds = [],
}) => {
  const scopeId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);
  if (!open) return null;

  const title = result?.wordOrPhrase || selectedText || 'Word card';

  return createPortal(
    <div
      className="word-card-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Word card"
      data-word-card-dialog="true"
      data-word-card-scopes={[...ancestorCardIds, scopeId].join(' ')}
      style={{ zIndex: 60 + ancestorCardIds.length * 10 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="word-card-dialog" ref={dialogRef} onKeyDown={event => {
        if (!isTopWordCard(dialogRef.current?.parentElement ?? null)) return;
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const buttons = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])]
          .filter(element => !element.closest('details:not([open])') || element.tagName === 'SUMMARY');
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <div className="word-card-dialog__bar">
          <span className="word-card-dialog__label">Dictionary lookup</span>
          <button
            type="button"
            onClick={onClose}
            className="word-card-icon-button"
            aria-label="Close word card"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="word-card-state" aria-busy="true">
            <div className="word-card-state__icon">
              <Sparkles className="h-5 w-5 animate-pulse" />
            </div>
            <p className="word-card-state__title">Looking up</p>
            <p className="word-card-state__copy">Querying the enabled local dictionaries.</p>
          </div>
        ) : error ? (
          <div className="word-card-state" role="alert">
            <p className="word-card-state__title">查询暂时不可用</p>
            <p className="word-card-state__copy">{error}</p>
            {onRetrySources && <button type="button" className="word-card-action" onClick={onRetrySources}>重试词典</button>}
          </div>
        ) : result ? (
          <div className="word-card-body">
            <WordCardInteractions key={selectedText || result.wordOrPhrase} scopeId={scopeId} ancestorCardIds={ancestorCardIds}
              word={result.wordOrPhrase} onSpeak={onSpeak}>
            <header className="word-card-hero">
              <div className="min-w-0">
                <h3 className="word-card-hero__word">{result.wordOrPhrase}</h3>
                <div className="word-card-meta">
                  {result.phonetic && <span className="word-card-meta__phonetic">{result.phonetic}</span>}
                  {result.type && <span className="word-card-chip word-card-chip--accent">{result.type}</span>}
                  {result.cefrLevel && <span className="word-card-chip">{result.cefrLevel}</span>}
                  {result.tags?.map((tag) => <span key={tag} className="word-card-chip">{tag}</span>)}
                  {result.source && (
                    <span className="word-card-chip word-card-chip--source">
                      {result.source === 'dictionary' ? result.dictionarySources?.length
                        ? `${result.dictionarySources.length} 本词典` : result.dictionaryRef?.dictionaryName || 'Local dictionary' : 'AI explanation'}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onSpeak(result.wordOrPhrase)}
                className="word-card-speak"
                aria-label="Speak word"
                title="Speak word"
              >
                <Volume2 className="h-5 w-5" />
              </button>
            </header>

            {(onTranslate || onCopy) && (
              <div className="word-card-actions" aria-label="Word actions">
                {onTranslate && (
                  <button type="button" onClick={onTranslate} className="word-card-action">
                    <Globe className="h-4 w-4" />
                    Translate
                  </button>
                )}
                {onCopy && (
                  <button type="button" onClick={onCopy} className="word-card-action">
                    <Copy className="h-4 w-4" />
                    Copy
                  </button>
                )}
              </div>
            )}

            {!result.dictionarySources?.length && !result.dictionaryRecord && result.chineseTranslation && (
              <section className="word-card-translation">
                <span className="word-card-section__eyebrow">Chinese meaning</span>
                <p>{result.chineseTranslation}</p>
              </section>
            )}

            {!result.dictionarySources?.length && !result.dictionaryRecord && result.definitionChinese && !result.chineseTranslation && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Chinese meaning</span>
                <p className="word-card-copy">{result.definitionChinese}</p>
              </section>
            )}

            <DictionarySourceIssues issues={result.dictionarySourceIssues} misses={result.dictionarySourceMisses} onRetry={onRetrySources} />
            {result.dictionarySources?.length ? (
              <DictionarySourceSections sources={result.dictionarySources} onLookupRelated={onLookupRelated} />
            ) : result.dictionaryRecord ? (
              <DictionarySenseGroups record={result.dictionaryRecord} />
            ) : (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">English definition</span>
                {result.senses?.length ? (
                  <ol className="word-card-senses">
                    {result.senses.map((sense, idx) => (
                      <li key={idx} className="word-card-sense">
                        <span className="word-card-sense__index">{idx + 1}</span>
                        <div className="word-card-sense__body">
                          <p>
                            {sense.partOfSpeech && <span className="word-card-sense__pos">{sense.partOfSpeech}</span>}
                            <WordCardText text={sense.definition} />
                          </p>
                          {sense.definitionZh && <p className="word-card-sense__translation">{sense.definitionZh}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="word-card-copy word-card-copy--strong"><WordCardText text={result.definition} /></p>
                )}
              </section>
            )}

            {result.readingOriginalSentence && (
              <section className="word-card-section word-card-original-sentence">
                <span className="word-card-section__eyebrow">阅读原句</span>
                <p className="word-card-copy"><WordCardText text={result.readingOriginalSentence} /></p>
                <button type="button" className="word-card-action" aria-label="朗读阅读原句" onClick={() => onSpeak(result.readingOriginalSentence!)}>
                  <Volume2 className="h-4 w-4" aria-hidden="true" />朗读原句
                </button>
              </section>
            )}

            {!result.dictionarySources?.length && !result.dictionaryRecord && result.grammarRules?.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Grammar and usage</span>
                <ul className="word-card-bullet-list">
                  {result.grammarRules.map((rule, idx) => <li key={idx}><WordCardText text={rule} /></li>)}
                </ul>
              </section>
            )}

            {!result.dictionarySources?.length && result.exchanges && result.exchanges.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Word forms</span>
                <div className="word-card-chip-list">
                  {result.exchanges.map((exchange, idx) => (
                    <span key={idx} className="word-card-chip word-card-chip--form">
                      <span>{exchange.label}</span> <WordCardText text={exchange.value} />
                    </span>
                  ))}
                </div>
              </section>
            )}

            {!result.dictionarySources?.length && !result.dictionaryRecord && result.collocations && result.collocations.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Common collocations</span>
                <div className="word-card-chip-list">
                  {result.collocations.map((collocation, idx) => (
                    <span key={idx} className="word-card-chip word-card-chip--collocation">
                      <WordCardText text={collocation.en} />{collocation.zh && <span> · {collocation.zh}</span>}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {!result.dictionarySources?.length && result.relatedWords && result.relatedWords.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Related words</span>
                <div className="word-card-chip-list">
                  {result.relatedWords.map((related) => (
                    <button key={related} type="button" onClick={() => onLookupRelated(related)} className="word-card-chip word-card-chip--link">
                      {related}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {!result.dictionarySources?.length && !result.dictionaryRecord && result.exampleSentences?.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Examples</span>
                <ol className="word-card-examples">
                  {result.exampleSentences.map((sentence, idx) => (
                    <li key={idx}>
                      <span className="word-card-example__index">{idx + 1}</span>
                      <WordCardText text={sentence} />
                    </li>
                  ))}
                </ol>
              </section>
            )}
            </WordCardInteractions>
            <WordMemoryDetailsPanel key={result.wordOrPhrase} wordId={result.wordOrPhrase} />
          </div>
        ) : (
          <div className="word-card-state">
            <div className="word-card-state__empty-icon"><BookOpen className="h-6 w-6" /></div>
            <p className="word-card-state__title">No definition found</p>
            <p className="word-card-state__copy">Try searching for &quot;{title}&quot; online.</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
