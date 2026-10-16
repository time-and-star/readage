import { getArticleInlineParts } from './articlePresentation';
import { tokenizeEnglishText } from './englishTokens';
import { frenchLanguageAdapter } from '../../packages/dictionary/languages/french';
import { japaneseLanguageAdapter } from '../../packages/dictionary/languages/japanese';

export type ReadingToken =
  | { type: 'word'; value: string; tokenIndex: number }
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string; tokenIndex: number };

const paragraphCache = new Map<string, ReadingToken[]>();
const MAX_CACHED_PARAGRAPHS = 512;
const MAX_CACHED_CHARACTERS = 1_000_000;
let cachedCharacters = 0;
const copyTokens = (tokens: readonly ReadingToken[]): ReadingToken[] => tokens.map(token => ({ ...token }));

/** Insert an annotation at a displayed-text offset without changing lookup token ids. */
export function splitReadingTokensForAnnotation(tokens: readonly ReadingToken[], endOffset: number): [ReadingToken[], ReadingToken[]] {
  const before: ReadingToken[] = [];
  const after: ReadingToken[] = [];
  let offset = 0;
  let reached = false;
  for (const token of tokens) {
    const end = offset + token.value.length;
    if (reached || endOffset <= offset) {
      after.push(token);
      reached = true;
    } else if (endOffset < end) {
      // Keep words and links intact; punctuation/spacing can split at the exact selection end.
      if (token.type === 'text') {
        const cut = endOffset - offset;
        before.push({ ...token, value: token.value.slice(0, cut) });
        after.push({ ...token, value: token.value.slice(cut) });
      } else before.push(token);
      reached = true;
    } else before.push(token);
    offset = end;
  }
  return [before, after];
}

/** Shared index space for rendering, lookup and learning occurrences. */
export function tokenizeReadingParagraph(paragraph: string, language = 'en'): ReadingToken[] {
  const base = language.split('-')[0].toLowerCase();
  const cacheKey = `${base}\0${paragraph}`;
  const cached = paragraphCache.get(cacheKey);
  if (cached) {
    paragraphCache.delete(cacheKey);
    paragraphCache.set(cacheKey, cached);
    return copyTokens(cached);
  }
  const tokens: ReadingToken[] = [];
  let tokenIndex = 0;
  const adapter = base === 'fr' ? frenchLanguageAdapter : base === 'ja' ? japaneseLanguageAdapter : undefined;
  for (const part of getArticleInlineParts(paragraph)) {
    // Links are opaque boundaries, including multiword Markdown labels.
    if (part.type === 'link') {
      tokens.push({ ...part, tokenIndex: tokenIndex++ });
      continue;
    }
    const segmented = adapter
      ? adapter.segment!(part.value).map(segment => ({ type: segment.kind === 'term' ? 'word' : 'text', value: segment.text }))
      : base === 'en' ? tokenizeEnglishText(part.value) : [{ type: 'word', value: part.value }];
    for (const token of segmented) {
      tokens.push(token.type === 'word'
        ? { type: 'word', value: token.value, tokenIndex: tokenIndex++ }
        : { type: 'text', value: token.value });
    }
  }
  if (cacheKey.length <= MAX_CACHED_CHARACTERS) {
    paragraphCache.set(cacheKey, tokens);
    cachedCharacters += cacheKey.length;
    while (paragraphCache.size > MAX_CACHED_PARAGRAPHS || cachedCharacters > MAX_CACHED_CHARACTERS) {
      const oldest = paragraphCache.keys().next().value!;
      cachedCharacters -= oldest.length;
      paragraphCache.delete(oldest);
    }
    return copyTokens(tokens);
  }
  return tokens;
}
