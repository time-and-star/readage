import React, { useLayoutEffect, useRef } from 'react';
import type { TranslationResult } from '../types';

interface Props {
  loading: boolean;
  error: string | null;
  result: TranslationResult | null;
  onRetry: () => void;
  scrollWithinCard?: boolean;
}

/** A temporary annotation in the article flow, without taking over reading focus. */
export const SelectionTranslationNote: React.FC<Props> = ({ loading, error, result, onRetry, scrollWithinCard = false }) => {
  const note = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = note.current;
    if (element && scrollWithinCard) {
      const card = element.closest<HTMLElement>('.reading-lookup-card, .word-card-body, .word-card-dialog');
      if (card) {
        const offset = element.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom + 12;
        if (offset > 0) card.scrollTop += offset;
      }
      return;
    }
    if (element && element.getBoundingClientRect().top > window.innerHeight - 80) {
      element.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  }, [scrollWithinCard]);

  return (
    <span ref={note} className="reading-translation-note" role="region" aria-label="所选文字译文"
      aria-live="polite" aria-atomic="true" aria-busy={loading}
      data-selection-translation="true" data-reading-interaction="true">
      <span className="reading-translation-note__label">译文</span>
      {loading ? <span className="reading-translation-note__waiting">正在翻译…</span>
        : error ? <span role="alert">
          <span className="reading-translation-note__text">{error}</span>
          <button type="button" onClick={onRetry} className="reading-translation-note__retry">重试翻译</button>
        </span>
        : result && <span className="reading-translation-note__text" lang={result.targetLanguage === 'English' ? 'en' : 'zh-CN'}>{result.translatedText}</span>}
    </span>
  );
};
