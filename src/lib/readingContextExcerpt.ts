import { getSentenceBounds } from './readingTouchSelection';

export const READING_CONTEXT_MAX_WORDS = 24;
export const READING_CONTEXT_MAX_CHARACTERS = 180;

export interface ReadingContextExcerpt {
  /** Unmodified saved context, apart from outer whitespace. */
  fullText: string;
  /** The complete source sentence for reading aloud, without added ellipses. */
  sentence: string;
  text: string;
  matchedWord?: string;
  omittedBefore: boolean;
  omittedAfter: boolean;
  isExcerpt: boolean;
}

function findTarget(text: string, words: readonly string[]) {
  for (const word of words) {
    if (!word.trim()) continue;
    const pattern = word.trim().split(/\s+/u).map(part => Array.from(part, character => {
      if (/['’‘ʼ]/u.test(character)) return "['’‘ʼ]";
      if (/[-‐‑]/u.test(character)) return '[-‐‑]';
      return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('')).join('\\s+');
    for (const match of text.matchAll(new RegExp(pattern, 'giu'))) {
      const start = match.index!, end = start + match[0].length;
      const characters = Array.from(match[0]);
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
      if (!cjk.test(characters[0]) && start > 0 && /[\p{L}\p{M}\p{N}]/u.test(text[start - 1])) continue;
      if (!cjk.test(characters.at(-1)!) && end < text.length && /[\p{L}\p{M}\p{N}]/u.test(text[end])) continue;
      return { start, end, text: match[0] };
    }
  }
  return null;
}

/** A contiguous source excerpt, never a rewrite or a change to saved evidence. */
export function getReadingContextExcerpt(text: string, words: string | readonly string[]): ReadingContextExcerpt {
  const fullText = text.trim();
  const target = findTarget(fullText, typeof words === 'string' ? [words] : words);
  let bounds = getSentenceBounds(fullText, target?.start ?? 0) ?? { start: 0, end: fullText.length };
  // A phrase containing sentence punctuation must remain intact.
  if (target && target.end > bounds.end) bounds = { start: 0, end: fullText.length };
  const sentence = fullText.slice(bounds.start, bounds.end);
  let start = bounds.start, end = bounds.end;
  // CJK text also has useful boundaries when it contains no spaces. Other
  // chunks retain punctuation, apostrophes and hyphens exactly as written.
  const tokens = Array.from(sentence.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu),
    match => ({ start: bounds.start + match.index!, end: bounds.start + match.index! + match[0].length }));
  if (tokens.length > READING_CONTEXT_MAX_WORDS || sentence.length > READING_CONTEXT_MAX_CHARACTERS) {
    const focusStart = target ? Math.max(0, tokens.findIndex(token => token.end > target.start)) : 0;
    let focusEnd = focusStart;
    while (target && focusEnd + 1 < tokens.length && tokens[focusEnd + 1].start < target.end) focusEnd += 1;
    let left = focusStart, right = focusEnd;
    while (tokens.length) {
      const fits = (a: number, b: number) => b - a + 1 <= READING_CONTEXT_MAX_WORDS
        && tokens[b].end - tokens[a].start <= READING_CONTEXT_MAX_CHARACTERS;
      const canLeft = left > 0 && fits(left - 1, right);
      const canRight = right + 1 < tokens.length && fits(left, right + 1);
      if (!canLeft && !canRight) break;
      // Prefer about twice as much following context as preceding context.
      if (canLeft && (!canRight || focusStart - left <= (right - focusEnd) / 2)) left -= 1;
      else right += 1;
    }
    if (tokens.length) {
      start = left === 0 ? bounds.start : tokens[left].start;
      end = right === tokens.length - 1 ? bounds.end : tokens[right].end;
    }
  }
  return { fullText, sentence, text: fullText.slice(start, end), matchedWord: target?.text,
    omittedBefore: start > 0, omittedAfter: end < fullText.length,
    isExcerpt: start > 0 || end < fullText.length };
}
