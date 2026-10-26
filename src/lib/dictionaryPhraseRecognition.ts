import type { GrammarExplanation } from '../types';
import { isEnglishWord, normalizeEnglishLookupText } from '../../packages/dictionary/languages/englishSurface';
import { getReadingTermMatches } from './textHighlight';
import { tokenizeReadingParagraph } from './readingTokens';

function getDictionaryPhraseCandidates(card: GrammarExplanation): string[] {
  const phrases = new Set<string>();
  const add = (phrase: string | undefined) => {
    const value = phrase?.trim();
    if (value && /\s/u.test(value)) phrases.add(value);
  };

  card.collocations?.forEach(item => add(item.en));
  card.dictionaryRecord?.phrases.forEach(item => add(item.phrase));
  const records = [card.dictionaryRecord, ...(card.dictionarySources ?? []).map(source => source.record)];
  for (const record of records) {
    record?.partOfSpeechGroups.forEach(group => group.senses.forEach(sense =>
      sense.collocations.forEach(item => add(item.en))));
    record?.phrases.forEach(item => add(item.phrase));
  }
  return [...phrases];
}

/** Find a dictionary-listed phrase containing the clicked word in this paragraph. */
export function recognizeDictionaryPhraseAtToken(
  paragraph: string,
  clickedTokenIndex: number,
  card: GrammarExplanation,
): string | null {
  if (!Number.isInteger(clickedTokenIndex) || clickedTokenIndex < 0) return null;
  const tokens = tokenizeReadingParagraph(paragraph);
  const clickedToken = tokens.find(token => token.type === 'word' && token.tokenIndex === clickedTokenIndex);
  const dictionaryHeadword = normalizeEnglishLookupText(card.wordOrPhrase);
  const clickedSurface = clickedToken ? normalizeEnglishLookupText(clickedToken.value).toLowerCase() : '';
  const headword = dictionaryHeadword.toLowerCase();
  const confirmedSurface = clickedSurface === headword
    || card.exchanges?.some(form => normalizeEnglishLookupText(form.value).toLowerCase() === clickedSurface)
    || card.dictionaryRecord?.wordForms.some(form => normalizeEnglishLookupText(form.value).toLowerCase() === clickedSurface)
    || card.dictionarySources?.some(source => source.record.wordForms.some(form => normalizeEnglishLookupText(form.value).toLowerCase() === clickedSurface));
  const matchingTokens = clickedToken && isEnglishWord(dictionaryHeadword) && confirmedSurface
    ? tokens.map(token => token === clickedToken ? { ...token, value: dictionaryHeadword } : token)
    : tokens;
  const match = getReadingTermMatches(matchingTokens, getDictionaryPhraseCandidates(card))
    .find(item => item.tokenLength > 1 && clickedTokenIndex >= item.tokenIndex
      && clickedTokenIndex < item.tokenIndex + item.tokenLength);
  return match?.term ?? null;
}
