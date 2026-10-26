import type { GrammarExplanation } from '../types';
import { isEnglishWord, normalizeEnglishLookupText } from '../../packages/dictionary/languages/englishSurface';
import { createWordCardRequest, fetchWordCard, type FetchWordCardOptions, type WordCardRequest } from './wordCard';
import { recognizeDictionaryPhraseAtToken } from './dictionaryPhraseRecognition';

type WordCardFetcher = typeof fetchWordCard;

export interface ReadingWordCardResult {
  card: GrammarExplanation;
  /** Present only when an exact dictionary-listed phrase was found and its own lookup succeeded. */
  recognizedPhrase?: string;
}

/** Look up the clicked word first, then upgrade to an exact dictionary-listed phrase when present. */
export async function fetchReadingWordCard(
  request: WordCardRequest,
  options: FetchWordCardOptions & { clickedTokenIndex?: number },
  lookup: WordCardFetcher = fetchWordCard,
): Promise<ReadingWordCardResult> {
  const card = await lookup(request, options);
  const { clickedTokenIndex } = options;
  if (clickedTokenIndex === undefined || !isEnglishWord(request.selectedText)) return { card };

  const phrase = recognizeDictionaryPhraseAtToken(request.contextSentence, clickedTokenIndex, card);
  if (!phrase || normalizeEnglishLookupText(phrase).toLowerCase() === request.selectedText.toLowerCase()) return { card };
  const phraseRequest = createWordCardRequest(phrase, request.contextSentence);
  if (!phraseRequest) return { card };

  try {
    const phraseCard = await lookup(phraseRequest, options);
    if (normalizeEnglishLookupText(phraseCard.wordOrPhrase).toLowerCase()
      === normalizeEnglishLookupText(phrase).toLowerCase()) {
      return { card: phraseCard, recognizedPhrase: phraseRequest.selectedText };
    }
  } catch {
    options.signal?.throwIfAborted();
    // Phrase enrichment is optional. Keep the successfully resolved word card.
  }
  return { card };
}
