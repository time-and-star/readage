import type { Article } from '../types';
import { getArticleCefrLevel } from './articleLevel';

export interface UserLibraryFile {
  id: string;
  title: string;
  format: NonNullable<Article['importBatchFormat']>;
  articles: Article[];
}

export type UserLibraryItem =
  | { kind: 'file'; file: UserLibraryFile }
  | { kind: 'article'; article: Article };

function batchOrder(article: Article): number {
  const match = article.id.match(/-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

/** Imported books/documents advance in source order within the same file. */
export function getNextImportedArticle(article: Article, articles: readonly Article[]): Article | undefined {
  if (!article.importBatchId) return undefined;
  const ordered = articles.filter(item => item.importBatchId === article.importBatchId)
    .slice().sort((a, b) => batchOrder(a) - batchOrder(b));
  const index = ordered.findIndex(item => item.id === article.id);
  return index >= 0 ? ordered[index + 1] : undefined;
}

/** Newest history order in, file reading order inside each imported file. */
export function groupUserLibrary(articles: readonly Article[]): UserLibraryItem[] {
  const groups = new Map<string, UserLibraryFile>();
  const items: UserLibraryItem[] = [];

  for (const article of articles) {
    const batchId = article.importBatchId?.trim();
    if (!batchId) {
      items.push({ kind: 'article', article });
      continue;
    }
    const existing = groups.get(batchId);
    if (existing) {
      existing.articles.push(article);
      continue;
    }
    const file: UserLibraryFile = {
      id: batchId,
      title: article.importBatchTitle?.trim() || 'Imported file',
      format: article.importBatchFormat || 'text',
      articles: [article],
    };
    groups.set(batchId, file);
    items.push({ kind: 'file', file });
  }

  for (const item of items) {
    if (item.kind === 'file') {
      item.file.articles.sort((a, b) => batchOrder(a) - batchOrder(b));
    }
  }
  return items;
}

function matchesLevel(article: Article, level: string): boolean {
  if (level === 'All') return true;
  return getArticleCefrLevel(article) === level;
}

function matchesArticleQuery(article: Article, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    article.title.toLowerCase().includes(q)
    || article.description.toLowerCase().includes(q)
    || (article.topic || '').toLowerCase().includes(q)
  );
}

/**
 * Shelf view when `batchId` is empty: imported files plus loose articles.
 * Article view when `batchId` is set: only that file, in reading order.
 */
export function filterUserLibrary(
  articles: readonly Article[],
  options: { level: string; query: string; batchId?: string | null },
): UserLibraryItem[] {
  const query = options.query.trim();
  const grouped = groupUserLibrary(articles);

  if (options.batchId) {
    const file = grouped.find((item) => item.kind === 'file' && item.file.id === options.batchId);
    if (!file || file.kind !== 'file') return [];
    return file.file.articles
      .filter((article) => matchesLevel(article, options.level) && matchesArticleQuery(article, query))
      .map((article) => ({ kind: 'article' as const, article }));
  }

  const shelf: UserLibraryItem[] = [];
  for (const item of grouped) {
    if (item.kind === 'article') {
      if (matchesLevel(item.article, options.level) && matchesArticleQuery(item.article, query)) {
        shelf.push(item);
      }
      continue;
    }
    const inLevel = item.file.articles.filter((article) => matchesLevel(article, options.level));
    if (inLevel.length === 0) continue;
    if (!query) {
      shelf.push(item);
      continue;
    }
    const titleHit = item.file.title.toLowerCase().includes(query.toLowerCase());
    const articleHit = inLevel.some((article) => matchesArticleQuery(article, query));
    if (titleHit || articleHit) shelf.push(item);
  }
  return shelf;
}

export function importBatchFormatLabel(format: string | undefined): string {
  if (format === 'epub') return 'EPUB';
  if (format === 'pdf') return 'PDF';
  if (format === 'docx') return 'Word';
  if (format === 'html') return 'HTML';
  if (format === 'text') return 'TXT';
  return 'FILE';
}
