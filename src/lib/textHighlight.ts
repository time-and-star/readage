import { toLemma } from './proficiency.legacy';
import { normalizeEnglishSurface } from './englishTokens';
import { tokenizeReadingParagraph, type ReadingToken } from './readingTokens';

export interface ReadingTermMatch {
  term: string;
  tokenIndex: number;
  tokenLength: number;
}

/** Match whole words; punctuation/links block phrases and longer phrases win. */
export function getReadingTermMatches(tokens: readonly ReadingToken[], terms: readonly string[]): ReadingTermMatch[] {
  const normalizedTerms = terms.map((term) => ({ term, normalized: toLemma(normalizeEnglishSurface(term)) }))
    .filter(({ normalized }) => Boolean(normalized))
    .sort((a, b) => b.normalized.split(' ').length - a.normalized.split(' ').length
      || b.normalized.length - a.normalized.length);
  const matches: ReadingTermMatch[] = [];
  const occupied = new Set<number>();
  // Resolve long ranges first, even when a shorter overlapping range starts earlier.
  for (const { term, normalized } of normalizedTerms) {
    const compoundGaps = new Set<number>();
    let termWords = 0;
    for (const token of tokenizeReadingParagraph(term)) {
      if (token.type === 'word') termWords += 1;
      else if (token.type === 'text' && /^[-\u2010\u2011]$/u.test(token.value)) compoundGaps.add(termWords);
    }
    for (let start = 0; start < tokens.length; start++) {
      const first = tokens[start];
      if (first.type !== 'word' || occupied.has(first.tokenIndex)) continue;
      let candidate = '';
      const indices: number[] = [];
      for (let end = start; end < tokens.length; end++) {
        const token = tokens[end];
        if (token.type === 'text') {
          const hyphen = /^[-\u2010\u2011]$/u.test(token.value);
          if (compoundGaps.has(indices.length) ? !hyphen : !/^\s+$/u.test(token.value)) break;
          continue;
        }
        if (token.type !== 'word' || occupied.has(token.tokenIndex)) break;
        candidate += `${candidate ? ' ' : ''}${toLemma(normalizeEnglishSurface(token.value))}`;
        indices.push(token.tokenIndex);
        if (candidate === normalized) {
          matches.push({ term, tokenIndex: first.tokenIndex, tokenLength: indices.length });
          indices.forEach((index) => occupied.add(index));
          break;
        }
        if (!normalized.startsWith(`${candidate} `)) break;
      }
    }
  }
  return matches.sort((a, b) => a.tokenIndex - b.tokenIndex);
}

/**
 * Returns the full matched term for every token that belongs to an exact
 * word/phrase match. Longer phrases win over overlapping shorter terms.
 */
export function getPhraseHighlightMatches(
  tokens: string[],
  terms: string[]
): Array<string | null> {
  // Keep the legacy output positions while using the same punctuation boundaries.
  const readingTokens: ReadingToken[] = [];
  const pieceIndices = new Map<number, number>();
  let wordIndex = 0;
  tokens.forEach((piece, pieceIndex) => {
    if (pieceIndex > 0) readingTokens.push({ type: 'text', value: ' ' });
    for (const token of tokenizeReadingParagraph(piece)) {
      if (token.type === 'text') readingTokens.push(token);
      else {
        pieceIndices.set(wordIndex, pieceIndex);
        readingTokens.push({ ...token, tokenIndex: wordIndex++ });
      }
    }
  });
  const matches: Array<string | null> = Array(tokens.length).fill(null);
  for (const match of getReadingTermMatches(readingTokens, terms)) {
    for (let offset = 0; offset < match.tokenLength; offset++) {
      matches[pieceIndices.get(match.tokenIndex + offset)!] = match.term;
    }
  }
  return matches;
}
