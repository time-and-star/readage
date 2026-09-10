import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Copy, Globe, Sparkles, Volume2, X } from 'lucide-react';
import type { GrammarExplanation } from '../types';

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
}

/**
 * Independent word-card drawer: dictionary-first explain results (and AI fallback).
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
}) => {
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
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="word-card-dialog" ref={dialogRef} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const buttons = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? [])];
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
            <p className="word-card-state__copy">Checking the local dictionary first.</p>
          </div>
        ) : result ? (
          <div className="word-card-body">
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
                      {result.source === 'dictionary' ? 'Local dictionary' : 'AI explanation'}
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

            {result.chineseTranslation && (
              <section className="word-card-translation">
                <span className="word-card-section__eyebrow">Chinese meaning</span>
                <p>{result.chineseTranslation}</p>
              </section>
            )}

            {result.definitionChinese && !result.chineseTranslation && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Chinese meaning</span>
                <p className="word-card-copy">{result.definitionChinese}</p>
              </section>
            )}

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
                          {sense.definition}
                        </p>
                        {sense.definitionZh && <p className="word-card-sense__translation">{sense.definitionZh}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="word-card-copy word-card-copy--strong">{result.definition}</p>
              )}
            </section>

            {result.grammarRules?.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Grammar and usage</span>
                <ul className="word-card-bullet-list">
                  {result.grammarRules.map((rule, idx) => <li key={idx}>{rule}</li>)}
                </ul>
              </section>
            )}

            {result.exchanges && result.exchanges.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Word forms</span>
                <div className="word-card-chip-list">
                  {result.exchanges.map((exchange, idx) => (
                    <span key={idx} className="word-card-chip word-card-chip--form">
                      <span>{exchange.label}</span> {exchange.value}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {result.collocations && result.collocations.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Common collocations</span>
                <div className="word-card-chip-list">
                  {result.collocations.map((collocation, idx) => (
                    <span key={idx} className="word-card-chip word-card-chip--collocation">
                      {collocation.en}{collocation.zh && <span> · {collocation.zh}</span>}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {result.relatedWords && result.relatedWords.length > 0 && (
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

            {result.exampleSentences?.length > 0 && (
              <section className="word-card-section">
                <span className="word-card-section__eyebrow">Examples</span>
                <ol className="word-card-examples">
                  {result.exampleSentences.map((sentence, idx) => (
                    <li key={idx}>
                      <span className="word-card-example__index">{idx + 1}</span>
                      <span>{sentence}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
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
