import type { Article } from '../types';
import { classifyArticleParagraph } from './articlePresentation';

type ReadingArticle = Pick<Article, 'id' | 'title' | 'content'>;
export interface ArticleReadingProgress {
  articleId: string;
  contentVersion: string;
  completedParagraphs: number[];
  updatedAt: string;
}
export type ReadingProgressCollection = Record<string, ArticleReadingProgress>;

/** Content indices are only meaningful for the same title and original paragraphs. */
export function readingContentVersion(article: Pick<Article, 'title' | 'content'>): string {
  const text = JSON.stringify([article.title, article.content]);
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index += 1) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ text.charCodeAt(index);
  }
  return `reading-v1:${text.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

export function readableParagraphIndices(article: Pick<Article, 'title' | 'content'>): number[] {
  return article.content.flatMap((paragraph, index) => {
    const kind = classifyArticleParagraph(paragraph, article.title);
    return kind === 'furniture' || kind === 'title' ? [] : [index];
  });
}

export function normalizeReadingProgressCollection(value: unknown, fallback: ReadingProgressCollection = {}): ReadingProgressCollection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return Object.fromEntries(Object.entries(value).flatMap(([articleId, candidate]) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const row = candidate as Partial<ArticleReadingProgress>;
    if (row.articleId !== articleId || !articleId || typeof row.contentVersion !== 'string'
      || !row.contentVersion.startsWith('reading-v1:') || !Array.isArray(row.completedParagraphs)
      || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) return [];
    const completedParagraphs = [...new Set(row.completedParagraphs.filter(index => Number.isSafeInteger(index) && index >= 0))].sort((left, right) => left - right);
    return [[articleId, { articleId, contentVersion: row.contentVersion, completedParagraphs, updatedAt: row.updatedAt }]];
  }));
}

export function completedReadingParagraphs(progress: ReadingProgressCollection, article: ReadingArticle): number[] {
  const row = Object.hasOwn(progress, article.id) ? progress[article.id] : undefined;
  if (!row || row.contentVersion !== readingContentVersion(article)) return [];
  const readable = new Set(readableParagraphIndices(article));
  return row.completedParagraphs.filter(index => readable.has(index));
}

/** Only call after the existing foreground/visibility/continuous-dwell check succeeds. */
export function markReadingParagraphComplete(
  previous: ReadingProgressCollection, article: ReadingArticle, paragraphIndex: number,
  updatedAt = new Date().toISOString(),
): ReadingProgressCollection {
  const progress = normalizeReadingProgressCollection(previous);
  if (!Number.isFinite(Date.parse(updatedAt)) || !readableParagraphIndices(article).includes(paragraphIndex)) return progress;
  const contentVersion = readingContentVersion(article);
  const prior = Object.hasOwn(progress, article.id) ? progress[article.id] : undefined;
  if (prior && prior.contentVersion !== contentVersion && Date.parse(prior.updatedAt) > Date.parse(updatedAt)) return progress;
  const completed = prior?.contentVersion === contentVersion ? completedReadingParagraphs(progress, article) : [];
  if (completed.includes(paragraphIndex)) return progress;
  return { ...progress, [article.id]: { articleId: article.id, contentVersion,
    completedParagraphs: [...completed, paragraphIndex].sort((left, right) => left - right),
    updatedAt: prior?.contentVersion === contentVersion && Date.parse(prior.updatedAt) > Date.parse(updatedAt) ? prior.updatedAt : updatedAt } };
}

export function hasCompletedReading(progress: ReadingProgressCollection, article: ReadingArticle): boolean {
  const required = readableParagraphIndices(article);
  const completed = new Set(completedReadingParagraphs(progress, article));
  return required.length > 0 && required.every(index => completed.has(index));
}
