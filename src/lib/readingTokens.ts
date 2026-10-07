import { getArticleInlineParts } from './articlePresentation';
import { tokenizeEnglishText } from './englishTokens';

export type ReadingToken =
  | { type: 'word'; value: string; tokenIndex: number }
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string; tokenIndex: number };

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
export function tokenizeReadingParagraph(paragraph: string): ReadingToken[] {
  const tokens: ReadingToken[] = [];
  let tokenIndex = 0;
  for (const part of getArticleInlineParts(paragraph)) {
    // Links are opaque boundaries, including multiword Markdown labels.
    if (part.type === 'link') {
      tokens.push({ ...part, tokenIndex: tokenIndex++ });
      continue;
    }
    for (const token of tokenizeEnglishText(part.value)) {
      tokens.push(token.type === 'word'
        ? { type: 'word', value: token.value, tokenIndex: tokenIndex++ }
        : { type: 'text', value: token.value });
    }
  }
  return tokens;
}
