import { useEffect, type RefObject } from 'react';
import type { Article } from '../types';
import { classifyArticleParagraph } from './articlePresentation';
import { readStorage, STORAGE_KEYS, updatePersistentValue } from './storage';

export interface ReadingBookmark {
  articleId: string;
  paragraphIndex: number;
  fraction: number;
  updatedAt: string;
  /** Version 2 stores the original content index, rather than the visible DOM ordinal. */
  anchorVersion?: 2;
}
export function normalizeReadingBookmark(value: unknown): ReadingBookmark | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as ReadingBookmark;
  return typeof row.articleId === 'string' && row.articleId.length > 0
    && Number.isInteger(row.paragraphIndex) && row.paragraphIndex >= 0
    && (row.anchorVersion === undefined || row.anchorVersion === 2)
    && Number.isFinite(row.fraction) && row.fraction >= 0 && row.fraction <= 1
    && Number.isFinite(Date.parse(row.updatedAt)) ? row : null;
}

/** Upgrade old visible ordinals and move hidden-heading anchors into the reading text. */
export function resolveReadingBookmarkAnchor(
  bookmark: ReadingBookmark,
  article: Pick<Article, 'content' | 'title'>,
): { paragraphIndex: number; fraction: number } | null {
  const kinds = article.content.map(paragraph => classifyArticleParagraph(paragraph, article.title));
  const originalIndex = bookmark.anchorVersion === 2
    ? bookmark.paragraphIndex
    : kinds.flatMap((kind, index) => kind === 'furniture' ? [] : [index])[bookmark.paragraphIndex];
  const readableIndices = kinds.flatMap((kind, index) => kind === 'furniture' || kind === 'title' ? [] : [index]);
  if (!readableIndices.length) return null;
  if (originalIndex !== undefined && readableIndices.includes(originalIndex)) {
    return { paragraphIndex: originalIndex, fraction: bookmark.fraction };
  }
  const nextIndex = originalIndex === undefined ? undefined : readableIndices.find(index => index > originalIndex);
  return { paragraphIndex: nextIndex ?? readableIndices[readableIndices.length - 1], fraction: 0 };
}
export function readReadingBookmark(): ReadingBookmark | null {
  try { return readStorage(window.localStorage, STORAGE_KEYS.readingBookmark, null, normalizeReadingBookmark); }
  catch { return null; }
}

/** Save a paragraph anchor so font and viewport changes do not invalidate the position. */
export function useReadingBookmark(
  articleId: string,
  root: RefObject<HTMLElement | null>,
  article?: Pick<Article, 'content' | 'title'>,
) {
  const content = article?.content;
  const title = article?.title;
  useEffect(() => {
    let restored = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const paragraphs = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-reading-paragraph]') ?? [])]
      .filter(element => element.closest('[data-reading-article-section]')?.getAttribute('data-reading-article-id') === articleId);
    const save = () => {
      if (!restored) return;
      const items = paragraphs();
      if (!items.length) return;
      const visibleIndex = items.findIndex(element => element.getBoundingClientRect().bottom > 130);
      const index = visibleIndex < 0 ? items.length - 1 : visibleIndex;
      const rect = items[index].getBoundingClientRect();
      const paragraphIndex = Number(items[index].dataset.readingParagraph);
      if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) return;
      const bookmark: ReadingBookmark = { articleId, paragraphIndex, anchorVersion: 2,
        fraction: Math.min(1, Math.max(0, (130 - rect.top) / Math.max(1, rect.height))), updatedAt: new Date().toISOString() };
      void updatePersistentValue<ReadingBookmark | null>(STORAGE_KEYS.readingBookmark, null,
        previous => previous && previous.updatedAt > bookmark.updatedAt ? previous : bookmark).catch(() => {});
    };
    const bookmark = readReadingBookmark();
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const items = paragraphs();
        const matchesArticle = bookmark?.articleId === articleId;
        const anchor = matchesArticle && content && title !== undefined
          ? resolveReadingBookmarkAnchor(bookmark, { content, title }) : null;
        const paragraphIndex = anchor?.paragraphIndex ?? bookmark?.paragraphIndex;
        const item = !matchesArticle ? undefined : bookmark.anchorVersion === 2 || anchor
          ? items.find(element => Number(element.dataset.readingParagraph) === paragraphIndex)
          : items[bookmark.paragraphIndex];
        const fraction = anchor?.fraction ?? bookmark?.fraction ?? 0;
        const rect = item?.getBoundingClientRect();
        window.scrollTo({ top: rect ? window.scrollY + rect.top + rect.height * fraction - 130 : 0, behavior: 'instant' });
        restored = true;
        save();
      });
    });
    const onScroll = () => {
      if (!restored || document.visibilityState !== 'visible' || timer) return;
      timer = setTimeout(() => { timer = undefined; save(); }, 250);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [articleId, root, content, title]);
}
