/** Normalize typography without stemming words or merging their boundaries. */
export function normalizeEnglishSurface(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\u00ad/g, '');
}

export function isEnglishWord(text: string): boolean {
  return /^[a-z]+(?:['-][a-z]+)*$/i.test(normalizeEnglishSurface(text).trim());
}

export interface EnglishTextToken {
  type: 'word' | 'text';
  value: string;
  start: number;
  end: number;
}

/** Keep original text/offsets; contractions and hyphenated compounds are one word. */
export function tokenizeEnglishText(text: string): EnglishTextToken[] {
  const result: EnglishTextToken[] = [];
  const words = /[a-z]+(?:['\u2018\u2019\u02bc\-\u2010\u2011\u00ad][a-z]+)*/gi;
  let cursor = 0;
  for (const match of text.matchAll(words)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (start > cursor) result.push({ type: 'text', value: text.slice(cursor, start), start: cursor, end: start });
    result.push({ type: 'word', value: match[0], start, end });
    cursor = end;
  }
  if (cursor < text.length) result.push({ type: 'text', value: text.slice(cursor), start: cursor, end: text.length });
  return result;
}
