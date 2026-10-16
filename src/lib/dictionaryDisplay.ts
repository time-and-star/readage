import type { GrammarExplanation } from '../types';

type DictionaryNameRef = { dictionaryId: string; dictionaryName?: string };

/** The built-in dictionary keeps its identity across display-name changes. */
export function dictionaryDisplayName(source?: DictionaryNameRef): string | undefined {
  return source?.dictionaryId === 'native-reviewed' ? 'ReadAge 自编词典' : source?.dictionaryName;
}

function currentName<T extends DictionaryNameRef>(source: T): T {
  const dictionaryName = dictionaryDisplayName(source);
  return dictionaryName === source.dictionaryName ? source : { ...source, dictionaryName };
}

/** Present cached cards with the current name without rewriting stored content. */
export function withCurrentDictionaryNames(card: GrammarExplanation): GrammarExplanation {
  return {
    ...card,
    ...(card.dictionaryRef ? { dictionaryRef: currentName(card.dictionaryRef) } : {}),
    ...(card.dictionarySources ? { dictionarySources: card.dictionarySources.map(source => ({
      ...source, dictionaryRef: currentName(source.dictionaryRef),
    })) } : {}),
    ...(card.dictionarySourceIssues ? { dictionarySourceIssues: card.dictionarySourceIssues.map(currentName) } : {}),
    ...(card.dictionarySourceMisses ? { dictionarySourceMisses: card.dictionarySourceMisses.map(currentName) } : {}),
  };
}
