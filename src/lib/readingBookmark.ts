import { useEffect, type RefObject } from 'react';
import { readStorage, STORAGE_KEYS, updatePersistentValue } from './storage';

export interface ReadingBookmark {
  articleId: string;
  paragraphIndex: number;
  fraction: number;
  updatedAt: string;
}
export function normalizeReadingBookmark(value: unknown): ReadingBookmark | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as ReadingBookmark;
  return typeof row.articleId === 'string' && row.articleId.length > 0
    && Number.isInteger(row.paragraphIndex) && row.paragraphIndex >= 0
    && Number.isFinite(row.fraction) && row.fraction >= 0 && row.fraction <= 1
    && Number.isFinite(Date.parse(row.updatedAt)) ? row : null;
}
export function readReadingBookmark(): ReadingBookmark | null {
  try { return readStorage(window.localStorage, STORAGE_KEYS.readingBookmark, null, normalizeReadingBookmark); }
  catch { return null; }
}

/** Save a paragraph anchor so font and viewport changes do not invalidate the position. */
export function useReadingBookmark(articleId: string, root: RefObject<HTMLElement | null>) {
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
      const bookmark: ReadingBookmark = { articleId, paragraphIndex: index,
        fraction: Math.min(1, Math.max(0, (130 - rect.top) / Math.max(1, rect.height))), updatedAt: new Date().toISOString() };
      void updatePersistentValue<ReadingBookmark | null>(STORAGE_KEYS.readingBookmark, null,
        previous => previous && previous.updatedAt > bookmark.updatedAt ? previous : bookmark).catch(() => {});
    };
    const bookmark = readReadingBookmark();
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const items = paragraphs();
        const item = bookmark?.articleId === articleId ? items[bookmark.paragraphIndex] : undefined;
        const rect = item?.getBoundingClientRect();
        window.scrollTo({ top: rect && bookmark ? window.scrollY + rect.top + rect.height * bookmark.fraction - 130 : 0, behavior: 'instant' });
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
  }, [articleId, root]);
}
