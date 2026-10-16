import { useContext, type FC, type ReactNode } from 'react';
import { WordCardInteractionContext } from './WordCardInteractionContext';

/** All related-word entry points use the existing child-card stack when inside a card. */
export const WordCardRelatedButton: FC<{
  word: string; onLookup?: (word: string) => void; children?: ReactNode; className?: string; language?: string;
}> = ({ word, onLookup, children = word, className, language = 'en' }) => {
  const actions = useContext(WordCardInteractionContext);
  return <button type="button" className={className} lang={language} onClick={event => {
    if (actions) actions.lookup(word, event.currentTarget.getBoundingClientRect());
    else onLookup?.(word);
  }}>{children}</button>;
};
