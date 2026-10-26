import React, { useMemo } from 'react';
import { ArrowLeftRight, BookOpen, ChevronDown, Link2, Quote, type LucideIcon } from 'lucide-react';
import type { GrammarExplanation } from '../types';
import { getFlashcardStudyContent } from '../lib/flashcardStudyContent';
import { ReadingContextExcerpt } from './ReadingContextExcerpt';
import { WordCardOriginalSentence } from './WordCardOriginalSentence';
import { WordCardText } from './WordCardText';
import './flashcardStudyContent.css';

export interface FlashcardStudyContentProps {
  card: GrammarExplanation | null;
  contextTexts?: string[];
  word: string;
  aliases?: string[];
}

function ContentSection({ label, icon: Icon, children }: {
  label: string; icon: LucideIcon; children: React.ReactNode;
}) {
  return <section className="flashcard-study-section" aria-label={label}>
    <h3 className="flashcard-study-section__label"><Icon aria-hidden="true" /><span>{label}</span></h3>
    <div className="flashcard-study-section__body">{children}</div>
  </section>;
}

function MoreContent({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  if (count <= 0) return null;
  return <details className="flashcard-study-more">
    <summary onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    }}><span>{label}<span className="flashcard-study-more__count">（{count}）</span></span><ChevronDown aria-hidden="true" /></summary>
    <div className="flashcard-study-more__body">{children}</div>
  </details>;
}

/** Read-only study notes. The screen owns grading, audio and the complete dictionary entry. */
export const FlashcardStudyContent: React.FC<FlashcardStudyContentProps> = ({ card, contextTexts = [], word, aliases = [] }) => {
  const content = useMemo(() => getFlashcardStudyContent(card, word, contextTexts), [card, word, contextTexts]);
  const contextAliases = card?.readingOriginalWord ? [card.readingOriginalWord, ...aliases] : aliases;
  const hasRelations = content.synonyms.length > 0 || content.antonyms.length > 0;
  if (!content.meanings.length && !content.examples.length && !content.collocations.length && !hasRelations && !content.readingContexts.length) return null;
  const renderMeaning = (meaning: typeof content.meanings[number], index: number) => <li
    key={JSON.stringify([meaning.partOfSpeech, meaning.en, meaning.zh])}
    className={`flashcard-study-meaning${meaning.primary ? ' flashcard-study-meaning--primary' : ''}`}>
    <div className="flashcard-study-meaning__meta">
          {index > 0 && <span className="flashcard-study-meaning__index">{index + 1}.</span>}
      {meaning.partOfSpeech && <span className="flashcard-study-pos" lang="en">{meaning.partOfSpeech}</span>}
    </div>
    <div className="flashcard-study-meaning__copy">
      {meaning.zh && <p className="flashcard-study-translation" lang="zh-CN">{meaning.zh}</p>}
      {meaning.en && meaning.en !== meaning.zh && <p className="flashcard-study-english" lang="en"><WordCardOriginalSentence text={meaning.en} word={word} /></p>}
    </div>
  </li>;
  const renderExample = (example: typeof content.examples[number]) => <article className="flashcard-study-example" key={JSON.stringify([example.en, example.zh])}>
    {example.sense && <p className="flashcard-study-sense" lang="zh-CN">{example.sense}</p>}
    <p className="flashcard-study-english" lang="en"><WordCardOriginalSentence text={example.en} word={word} /></p>
    {example.zh && <p className="flashcard-study-translation" lang="zh-CN">{example.zh}</p>}
  </article>;
  const renderContext = (context: string) => <ReadingContextExcerpt key={context} text={context} word={word} aliases={contextAliases} />;
  const renderCollocation = (collocation: typeof content.collocations[number]) => <div key={JSON.stringify([collocation.en, collocation.zh])}>
    <dt className="flashcard-study-english" lang="en"><WordCardOriginalSentence text={collocation.en} word={word} /></dt>
    {collocation.zh && <dd className="flashcard-study-translation" lang="zh-CN">{collocation.zh}</dd>}
  </div>;
  const renderRelation = (relation: typeof content.synonyms[number]) => <li key={JSON.stringify([relation.word, relation.zh, relation.note, relation.sense])}>
    <div className="flashcard-study-relation__line"><span className="flashcard-study-english" lang="en"><WordCardText text={relation.word} /></span>
      {relation.zh && <span className="flashcard-study-translation" lang="zh-CN">{relation.zh}</span>}</div>
    {relation.sense && <p className="flashcard-study-sense" lang="zh-CN">{relation.sense}</p>}
    {relation.note && <p className="flashcard-study-relation__note" lang="zh-CN">{relation.note}</p>}
  </li>;
  return <div key={word} className="flashcard-study-content">
    {content.meanings.length > 0 && <ContentSection label="释义" icon={BookOpen}>
      <ol className="flashcard-study-meanings">{content.meanings.slice(0, 1).map(renderMeaning)}</ol>
      <MoreContent label="更多释义" count={content.meanings.length - 1}>
        <ol className="flashcard-study-meanings" start={2}>{content.meanings.slice(1).map((meaning, index) => renderMeaning(meaning, index + 1))}</ol>
      </MoreContent>
    </ContentSection>}

    {content.examples.length > 0 && <ContentSection label="例句" icon={Quote}>
      <div className="flashcard-study-examples">{content.examples.slice(0, 1).map(renderExample)}</div>
      <MoreContent label="更多例句" count={content.examples.length - 1}>
        <div className="flashcard-study-examples">{content.examples.slice(1).map(renderExample)}</div>
      </MoreContent>
    </ContentSection>}

    {content.readingContexts.length > 0 && <ContentSection label="原句" icon={Quote}>
      <div className="flashcard-study-contexts">{content.readingContexts.slice(0, 1).map(renderContext)}</div>
      <MoreContent label="更多原句" count={content.readingContexts.length - 1}>
        <div className="flashcard-study-contexts">{content.readingContexts.slice(1).map(renderContext)}</div>
      </MoreContent>
    </ContentSection>}

    {content.collocations.length > 0 && <ContentSection label="搭配" icon={Link2}>
      <dl className="flashcard-study-collocations">{content.collocations.slice(0, 3).map(renderCollocation)}</dl>
      <MoreContent label="更多搭配" count={content.collocations.length - 3}>
        <dl className="flashcard-study-collocations">{content.collocations.slice(3).map(renderCollocation)}</dl>
      </MoreContent>
    </ContentSection>}

    {hasRelations && <ContentSection label="同反义" icon={ArrowLeftRight}>
      <div className="flashcard-study-relations">{(['synonyms', 'antonyms'] as const).map(kind => content[kind].length > 0 && <div key={kind}>
        <h4>{kind === 'synonyms' ? '同义词' : '反义词'}</h4>
        <ul>{content[kind].slice(0, 3).map(renderRelation)}</ul>
        <MoreContent label={kind === 'synonyms' ? '更多同义词' : '更多反义词'} count={content[kind].length - 3}>
          <ul>{content[kind].slice(3).map(renderRelation)}</ul>
        </MoreContent>
      </div>)}</div>
    </ContentSection>}
  </div>;
};
