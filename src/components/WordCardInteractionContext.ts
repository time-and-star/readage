import { createContext } from 'react';

export interface WordCardTextActions {
  lookup: (word: string, rect: DOMRect) => void;
  select: (text: string, range: Range, touch: boolean) => void;
}

export const WordCardInteractionContext = createContext<WordCardTextActions | null>(null);
