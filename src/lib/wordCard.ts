import type { GrammarExplanation } from '../types';
import { postTutor, TutorApiError } from './tutorClient';
import { lookupDictionaryWord, toDictionaryWordCard } from './dictionaryClient';
import { isEnglishWord, normalizeEnglishSurface } from './englishTokens';

export interface WordCardRequest {
  selectedText: string;
  contextSentence: string;
}

/** Max lookup text length aligned with tutor validation. */
export const WORD_CARD_MAX_SELECTED_TEXT = 2_000;
export const WORD_CARD_MAX_CONTEXT = 3_000;

/**
 * Normalize a click or selection into a word-card lookup request.
 * Strips punctuation noise while keeping spaces/apostrophes for phrases.
 */
export function createWordCardRequest(
  wordOrPhrase: string,
  contextSentence = '',
): WordCardRequest | null {
  const selectedText = normalizeEnglishSurface(wordOrPhrase)
    .replace(/[^a-zA-Z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '')
    .slice(0, WORD_CARD_MAX_SELECTED_TEXT);
  if (!selectedText) return null;
  return {
    selectedText,
    contextSentence: contextSentence.trim().slice(0, WORD_CARD_MAX_CONTEXT),
  };
}

export interface FetchWordCardOptions {
  articleId?: string;
  signal?: AbortSignal;
}

/**
 * Single words use the dictionary and bounded local cache.
 * Phrases and dictionary misses use AI. Failures never fabricate a definition.
 */
export async function fetchWordCard(
  request: WordCardRequest,
  options: FetchWordCardOptions = {},
): Promise<GrammarExplanation> {
  // Old cards may contain headwords chosen by unverified suffix stemming.
  const cacheKey = `english-ai:v4:word-card:${request.selectedText.toLowerCase()}`;
  const singleWord = isEnglishWord(request.selectedText);
  if (options.signal?.aborted) throw new Error('Lookup cancelled');
  if (singleWord) {
    try {
      const cached = typeof localStorage === 'undefined' ? null : localStorage.getItem(cacheKey);
      if (cached) {
        const card = JSON.parse(cached) as GrammarExplanation;
        if (card.source === 'dictionary' && card.definition && card.wordOrPhrase) return card;
      }
    } catch { /* A cache failure must not prevent a dictionary request. */ }
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(8_000)])
      : AbortSignal.timeout(8_000);
    try {
      const entry = await lookupDictionaryWord(request.selectedText, { signal });
      if (entry) {
        const card = toDictionaryWordCard(entry);
        try {
          if (typeof localStorage !== 'undefined') {
            const keys = Object.keys(localStorage).filter(key => key.startsWith('english-ai:v4:word-card:'));
            if (!keys.includes(cacheKey) && keys.length >= 500) {
              for (const key of keys.slice(0, keys.length - 499)) localStorage.removeItem(key);
            }
            localStorage.setItem(cacheKey, JSON.stringify(card));
          }
        }
        catch { /* Optional cache; learning persistence is handled separately. */ }
        return card;
      }
    } catch (error) {
      if (options.signal?.aborted) throw new Error('Lookup cancelled');
      throw new Error('词典暂时无法连接，请启动本地服务后重试。已缓存的单词仍可查询。');
    }
  }
  try {
    const response = await postTutor<GrammarExplanation>(
      {
        intent: 'explain',
        articleId: options.articleId,
        selectedText: request.selectedText,
        contextSentence: request.contextSentence,
      },
      fetch,
      { signal: options.signal, maxRetries: 0, timeoutMs: 20_000 },
    );
    return response.result;
  } catch (error) {
    if (error instanceof Error && /cancelled|abort/i.test(error.message)) {
      throw error;
    }
    if (error instanceof TutorApiError) throw error;
    throw new Error(singleWord
      ? '词典未收录此词，AI 解释暂不可用。请检查拼写或稍后重试。'
      : '句子解释暂不可用，请检查服务连接后重试。');
  }
}
