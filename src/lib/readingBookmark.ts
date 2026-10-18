import { useLayoutEffect, type RefObject } from 'react';
import type { Article } from '../types';
import { classifyArticleParagraph } from './articlePresentation';
import { readPersistentValue, readStorage, STORAGE_KEYS, updatePersistentValue } from './storage';
import { getApplicationStorage } from './localDatabase';
import { readingContentVersion } from './readingProgress';

export interface ReadingBookmark {
  articleId: string;
  paragraphIndex: number;
  fraction: number;
  updatedAt: string;
  /** Version 2 stores the original content index, rather than the visible DOM ordinal. */
  anchorVersion?: 2;
  /** A changed original article must not inherit a position in unrelated text. */
  contentVersion?: string;
}
export type ReadingBookmarkCollection = Record<string, ReadingBookmark>;
export function normalizeReadingBookmark(value: unknown): ReadingBookmark | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as ReadingBookmark;
  return typeof row.articleId === 'string' && row.articleId.length > 0
    && Number.isInteger(row.paragraphIndex) && row.paragraphIndex >= 0
    && (row.anchorVersion === undefined || row.anchorVersion === 2)
    && (row.contentVersion === undefined || (typeof row.contentVersion === 'string' && row.contentVersion.startsWith('reading-v1:')))
    && Number.isFinite(row.fraction) && row.fraction >= 0 && row.fraction <= 1
    && Number.isFinite(Date.parse(row.updatedAt)) ? row : null;
}

/** Upgrade old visible ordinals and move hidden-heading anchors into the reading text. */
export function resolveReadingBookmarkAnchor(
  bookmark: ReadingBookmark,
  article: Pick<Article, 'content' | 'title'>,
): { paragraphIndex: number; fraction: number } | null {
  if (bookmark.contentVersion && bookmark.contentVersion !== readingContentVersion(article)) return null;
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
export function normalizeReadingBookmarks(value: unknown, fallback: ReadingBookmarkCollection = {}): ReadingBookmarkCollection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return Object.fromEntries(Object.entries(value).flatMap(([articleId, candidate]) => {
    const bookmark = normalizeReadingBookmark(candidate);
    return bookmark && bookmark.articleId === articleId ? [[articleId, bookmark]] : [];
  }));
}

export function mergeReadingBookmark(previous: unknown, bookmark: ReadingBookmark | null): ReadingBookmarkCollection {
  const bookmarks = normalizeReadingBookmarks(previous);
  const next = normalizeReadingBookmark(bookmark);
  if (!next) return bookmarks;
  const prior = Object.hasOwn(bookmarks, next.articleId) ? bookmarks[next.articleId] : undefined;
  if (prior && Date.parse(prior.updatedAt) > Date.parse(next.updatedAt)) return bookmarks;
  return { ...bookmarks, [next.articleId]: next };
}

function browserStorage(): Storage | undefined {
  return getApplicationStorage();
}

export function readReadingBookmarks(storage = browserStorage()): ReadingBookmarkCollection {
  // A quick return to the reader must include writes still waiting for SQLite or the tab lock.
  const bookmarks = storage && storage === browserStorage()
    ? readPersistentValue(STORAGE_KEYS.readingBookmarks, {}, normalizeReadingBookmarks)
    : readStorage(storage, STORAGE_KEYS.readingBookmarks, {}, normalizeReadingBookmarks);
  const legacy = readStorage(storage, STORAGE_KEYS.readingBookmark, null, normalizeReadingBookmark);
  return mergeReadingBookmark(bookmarks, legacy);
}

/** No argument keeps the app's "resume latest article" behavior. */
export function readReadingBookmark(articleId?: string, storage = browserStorage()): ReadingBookmark | null {
  const bookmarks = readReadingBookmarks(storage);
  if (articleId !== undefined) return Object.hasOwn(bookmarks, articleId) ? bookmarks[articleId] : null;
  return Object.values(bookmarks).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null;
}

export function saveReadingBookmark(bookmark: ReadingBookmark): Promise<void> {
  const legacy = readStorage(browserStorage(), STORAGE_KEYS.readingBookmark, null, normalizeReadingBookmark);
  return updatePersistentValue<ReadingBookmarkCollection>(STORAGE_KEYS.readingBookmarks, {},
    previous => mergeReadingBookmark(mergeReadingBookmark(previous, legacy), bookmark));
}

/** Save a paragraph anchor so font and viewport changes do not invalidate the position. */
export function useReadingBookmark(
  articleId: string,
  root: RefObject<HTMLElement | null>,
  article?: Pick<Article, 'content' | 'title'>,
) {
  const content = article?.content;
  const title = article?.title;
  useLayoutEffect(() => {
    let restored = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let captureFrame = 0;
    let layoutFrame = 0;
    let disposed = false;
    let userInteracted = false;
    let lastSnapshot: ReadingBookmark | null = null;
    const contentVersion = content && title !== undefined ? readingContentVersion({ content, title }) : undefined;
    const paragraphs = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-reading-paragraph]') ?? [])]
      .filter(element => element.closest('[data-reading-article-section]')?.getAttribute('data-reading-article-id') === articleId);
    const capture = (): ReadingBookmark | null => {
      if (!restored) return null;
      const items = paragraphs();
      if (!items.length) return lastSnapshot;
      const visibleIndex = items.findIndex(element => element.getBoundingClientRect().bottom > 130);
      const index = visibleIndex < 0 ? items.length - 1 : visibleIndex;
      const rect = items[index].getBoundingClientRect();
      const paragraphIndex = Number(items[index].dataset.readingParagraph);
      if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) return lastSnapshot;
      return { articleId, paragraphIndex, anchorVersion: 2,
        ...(contentVersion ? { contentVersion } : {}),
        fraction: Math.min(1, Math.max(0, (130 - rect.top) / Math.max(1, rect.height))), updatedAt: new Date().toISOString() };
    };
    const save = () => {
      lastSnapshot = capture() ?? lastSnapshot;
      if (lastSnapshot) void saveReadingBookmark(lastSnapshot).catch(() => {});
    };
    const bookmark = readReadingBookmark(articleId);
    const restore = () => {
      const items = paragraphs();
      const matchesArticle = bookmark?.articleId === articleId;
      const anchor = matchesArticle && content && title !== undefined
        ? resolveReadingBookmarkAnchor(bookmark, { content, title }) : null;
      const usable = matchesArticle && (!(content && title !== undefined) || anchor !== null);
      const paragraphIndex = anchor?.paragraphIndex ?? bookmark?.paragraphIndex;
      const item = !usable ? undefined : bookmark.anchorVersion === 2 || anchor
        ? items.find(element => Number(element.dataset.readingParagraph) === paragraphIndex)
        : items[bookmark.paragraphIndex];
      const fraction = anchor?.fraction ?? bookmark?.fraction ?? 0;
      const rect = item?.getBoundingClientRect();
      window.scrollTo({ top: rect ? window.scrollY + rect.top + rect.height * fraction - 130 : 0, behavior: 'instant' });
      restored = true;
      save();
    };
    // Illustrations and fonts can arrive after the initial two frames. Keep the
    // saved paragraph in place until the reader takes control of the page.
    const correctLayout = () => {
      if (disposed || userInteracted || !restored || !bookmark || layoutFrame) return;
      layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; if (!disposed && !userInteracted) restore(); });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(correctLayout);
    const element = root.current;
    if (element) observer?.observe(element);
    element?.addEventListener('load', correctLayout, true);
    void document.fonts?.ready.then(correctLayout);
    const onInteraction = () => { userInteracted = true; observer?.disconnect(); };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) onInteraction();
    };
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!userInteracted) restore();
        else { restored = true; save(); }
      });
    });
    const onScroll = () => {
      if (!restored || document.visibilityState !== 'visible') return;
      if (!captureFrame) captureFrame = requestAnimationFrame(() => { captureFrame = 0; lastSnapshot = capture() ?? lastSnapshot; });
      if (!timer) timer = setTimeout(() => { timer = undefined; save(); }, 250);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', save);
    window.addEventListener('resize', correctLayout);
    window.addEventListener('wheel', onInteraction, { passive: true });
    window.addEventListener('touchstart', onInteraction, { passive: true });
    window.addEventListener('pointerdown', onInteraction, { passive: true });
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      // Layout cleanup captures the final position before React detaches the paragraphs.
      save();
      disposed = true;
      observer?.disconnect();
      element?.removeEventListener('load', correctLayout, true);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(captureFrame);
      cancelAnimationFrame(layoutFrame);
      if (timer) clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', save);
      window.removeEventListener('resize', correctLayout);
      window.removeEventListener('wheel', onInteraction);
      window.removeEventListener('touchstart', onInteraction);
      window.removeEventListener('pointerdown', onInteraction);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [articleId, root, content, title]);
}
