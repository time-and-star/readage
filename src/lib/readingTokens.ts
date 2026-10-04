import { getArticleInlineParts } from './articlePresentation';
import { tokenizeEnglishText } from './englishTokens';

export type ReadingToken =
  | { type: 'word'; value: string; tokenIndex: number }
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string; tokenIndex: number };

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
