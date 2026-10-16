/** Typography changes used for lookup, never for displayed text or offsets. */
export function normalizeEnglishSurface(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\u00ad/g, '');
}

export function isEnglishWord(text: string): boolean {
  const word = normalizeEnglishSurface(text).trim();
  return /[\p{Script=Latin}]/u.test(word)
    && /^[\p{Script=Latin}\p{M}0-9]+(?:['.-][\p{Script=Latin}\p{M}0-9]+)*\.?$/u.test(word);
}

/** Preserve dotted initials while trimming surrounding sentence punctuation. */
export function normalizeEnglishLookupText(text: string): string {
  const cleaned = normalizeEnglishSurface(text)
    .replace(/[^\p{Script=Latin}\p{M}0-9\s'.-]/gu, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[^\p{Script=Latin}0-9]+/u, '');
  if (/^(?:\p{Script=Latin}\.){2,}$/u.test(cleaned)) return cleaned;
  return cleaned.replace(/[^\p{Script=Latin}\p{M}0-9]+$/u, '');
}
