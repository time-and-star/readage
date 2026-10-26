import React, { useId, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { getReadingContextExcerpt, type ReadingContextExcerpt as Excerpt } from '../lib/readingContextExcerpt';
import { WordCardOriginalSentence } from './WordCardOriginalSentence';
import './readingContextExcerpt.css';

interface Props {
  text: string;
  word: string;
  aliases?: readonly string[];
  onSpeak?: (text: string) => void;
}

const ContextView: React.FC<{ excerpt: Excerpt; word: string; onSpeak?: Props['onSpeak'] }> = ({ excerpt, word, onSpeak }) => {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div className="reading-context-excerpt" data-expanded={expanded}>
    {excerpt.isExcerpt && <span className="reading-context-excerpt__label">{expanded ? '完整原句 / 语境' : '原句节选'}</span>}
    <p id={id} className="word-card-copy reading-context-excerpt__text">
      {!expanded && excerpt.omittedBefore && <span data-word-card-ignore="true">… </span>}
      <WordCardOriginalSentence text={expanded ? excerpt.fullText : excerpt.text} word={excerpt.matchedWord ?? word} />
      {!expanded && excerpt.omittedAfter && <span data-word-card-ignore="true"> …</span>}
    </p>
    {(excerpt.isExcerpt || onSpeak) && <div className="reading-context-excerpt__actions">
      {excerpt.isExcerpt && <button type="button" className="reading-context-excerpt__toggle" aria-expanded={expanded} aria-controls={id}
        onClick={event => { event.stopPropagation(); setExpanded(value => !value); }}>{expanded ? '收起原句' : '展开完整原句'}</button>}
      {onSpeak && <button type="button" className="word-card-action" aria-label="朗读完整原句"
        onClick={event => { event.stopPropagation(); onSpeak(excerpt.sentence); }}><Volume2 className="h-4 w-4" aria-hidden="true" />朗读原句</button>}
    </div>}
  </div>;
};

export const ReadingContextExcerpt: React.FC<Props> = ({ text, word, aliases = [], onSpeak }) => {
  const excerpt = getReadingContextExcerpt(text, [word, ...aliases]);
  // Changing source or word creates a fresh, collapsed view, including when
  // returning to a previous word. No preference or learning record is written.
  return <ContextView key={JSON.stringify([text, word, aliases])} excerpt={excerpt} word={word} onSpeak={onSpeak} />;
};
