import type { Article } from '../types';
import { classifyArticleParagraph, getArticleInlineParts } from './articlePresentation';
import type { SpeechTarget } from './speech';

function readingOffset(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
}

/** Keep the exact clicked occurrence, including when a dictionary pronounces its lemma. */
export function createReadingWordSpeechTarget(articleId: string, start: unknown, end: unknown): SpeechTarget | undefined {
  const startOffset = readingOffset(start);
  const endOffset = readingOffset(end);
  if (!articleId.trim() || startOffset === undefined || endOffset === undefined || endOffset <= startOffset) return undefined;
  return { articleId, startOffset, endOffset };
}

/** Word cards stay on their source word; article and selection speech follow spoken offsets. */
export function resolveSpeechHighlightRange(target: SpeechTarget, word: { start: number; end: number }): { start: number; end: number } | undefined {
  const startOffset = readingOffset(target.startOffset);
  if (startOffset === undefined) return undefined;
  if (target.endOffset !== undefined) {
    const endOffset = readingOffset(target.endOffset);
    return endOffset !== undefined && endOffset > startOffset ? { start: startOffset, end: endOffset } : undefined;
  }
  const wordStart = readingOffset(word.start);
  const wordEnd = readingOffset(word.end);
  if (wordStart === undefined || wordEnd === undefined || wordEnd <= wordStart) return undefined;
  const start = startOffset + wordStart;
  const end = startOffset + wordEnd;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) ? { start, end } : undefined;
}

export function buildReadingSpeech(article: Pick<Article, 'id' | 'title' | 'content'>) {
  let text = '';
  const paragraphs = new Map<number, { text: string; start: number }>();
  article.content.forEach((paragraph, index) => {
    const kind = classifyArticleParagraph(paragraph, article.title);
    if (kind === 'furniture' || kind === 'title') return;
    const visible = getArticleInlineParts(paragraph).map(part => part.value).join('');
    if (text) text += '\n\n';
    paragraphs.set(index, { text: visible, start: text.length });
    text += visible;
  });
  return { text, paragraphs };
}
