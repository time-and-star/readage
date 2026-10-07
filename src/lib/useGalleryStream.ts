import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { MagazineGalleryItem } from '../types';
import { appendGalleryWindow, trimGalleryWindow, type GalleryWindowItem } from './galleryWindow';

const WINDOW_SIZE = 48;

async function fetchBatch(cursor: string | null, signal: AbortSignal) {
  const query = new URLSearchParams({ limit: '12' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/magazines/gallery/stream?${query}`, { signal });
  const data = await response.json();
  if (!response.ok || !data.ok || !Array.isArray(data.items)
    || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !data.nextCursor.length))) {
    throw new Error('杂志图片暂时无法加载。');
  }
  return data as { items: MagazineGalleryItem[]; nextCursor: string | null };
}

/** Keep only the nearby exhibits while requesting a fresh batch as the visitor advances. */
export function useGalleryStream(track: RefObject<HTMLDivElement | null>) {
  const [items, setItems] = useState<GalleryWindowItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [autoBlocked, setAutoBlocked] = useState(false);
  const [activeSequence, setActiveSequence] = useState<number | null>(null);
  const [scrollSettled, setScrollSettled] = useState(true);
  const currentItems = useRef(items);
  const currentActive = useRef(activeSequence);
  const sequence = useRef(1);
  const request = useRef<AbortController | null>(null);
  const pendingAnchor = useRef<{ sequence: number; x: number } | null>(null);
  const scrolling = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedSources = useRef(new Set<string>());
  const emptyBatches = useRef(0);
  currentItems.current = items;
  currentActive.current = activeSequence;

  const setActive = useCallback((value: number | null) => {
    currentActive.current = value;
    setActiveSequence(value);
  }, []);
  const beginScroll = useCallback(() => {
    scrolling.current = true; setScrollSettled(false);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      scrolling.current = false; setScrollSettled(true);
    }, 180);
  }, []);
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);
  const rememberAnchor = useCallback(() => {
    const element = track.current;
    const active = element?.querySelector<HTMLElement>(`[data-gallery-sequence="${currentActive.current}"]`);
    if (element && active && currentActive.current !== null) {
      pendingAnchor.current = { sequence: currentActive.current,
        x: active.getBoundingClientRect().left - element.getBoundingClientRect().left };
    }
  }, [track]);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError(null); setPageError(null); setPageLoading(false);
    setCursor(null); setAutoBlocked(false); setActive(null); sequence.current = 1;
    failedSources.current.clear(); emptyBatches.current = 0;
    pendingAnchor.current = null;
    void fetchBatch(null, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      const result = appendGalleryWindow([], data.items, null, sequence.current);
      sequence.current = result.nextSequence;
      currentItems.current = result.items; setItems(result.items);
      setActive(result.items[0]?.sequence ?? null); setCursor(data.nextCursor);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '杂志图片暂时无法加载。');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    });
    return () => { controller.abort(); request.current?.abort(); request.current = null; };
  }, [reload, setActive]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading || request.current || currentItems.current.length > WINDOW_SIZE) return;
    if (!currentItems.current.length && ++emptyBatches.current > 3) {
      setAutoBlocked(true); setPageError('图片暂时无法显示，请稍后重试。'); return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPageLoading(true); setPageError(null);
    try {
      const data = await fetchBatch(cursor, controller.signal);
      if (!controller.signal.aborted) {
        const usable = data.items.filter(item => !failedSources.current.has(item.image.src));
        // Let an in-flight swipe or smooth navigation finish before retiring old cards.
        const result = appendGalleryWindow(currentItems.current, usable, currentActive.current, sequence.current,
          scrolling.current ? WINDOW_SIZE + 12 : WINDOW_SIZE);
        if (result.removed) rememberAnchor();
        const advanced = result.nextSequence > sequence.current;
        sequence.current = result.nextSequence;
        currentItems.current = result.items; setItems(result.items);
        setCursor(data.nextCursor); setAutoBlocked(!advanced);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setPageError(failure instanceof Error ? failure.message : '更多图片暂时无法加载。');
    } finally {
      if (!controller.signal.aborted) setPageLoading(false);
      if (request.current === controller) request.current = null;
    }
  }, [cursor, loading, rememberAnchor]);

  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    const element = track.current;
    if (anchor && element) {
      const active = element.querySelector<HTMLElement>(`[data-gallery-sequence="${anchor.sequence}"]`);
      if (active) element.scrollLeft += active.getBoundingClientRect().left - element.getBoundingClientRect().left - anchor.x;
    }
    pendingAnchor.current = null;
  }, [items, track]);

  useEffect(() => {
    if (!scrollSettled || items.length <= WINDOW_SIZE) return;
    const activeIndex = items.findIndex(item => item.sequence === activeSequence);
    // Trim a full batch once the active image is far enough from the beginning.
    if (activeIndex < items.length - WINDOW_SIZE + 12) return;
    const result = trimGalleryWindow(items, activeSequence);
    if (result.removed) {
      rememberAnchor(); currentItems.current = result.items; setItems(result.items);
    }
  }, [items, activeSequence, rememberAnchor, scrollSettled]);

  const removeImage = useCallback((source: string) => {
    failedSources.current.add(source);
    if (failedSources.current.size > 512) failedSources.current.delete(failedSources.current.values().next().value!);
    const previous = currentItems.current;
    rememberAnchor();
    const remaining = previous.filter(item => item.image.src !== source);
    currentItems.current = remaining; setItems(remaining);
    if (!remaining.some(item => item.sequence === currentActive.current)) {
      setActive(remaining[0]?.sequence ?? null);
    }
  }, [rememberAnchor, setActive]);
  const imageReady = useCallback(() => { emptyBatches.current = 0; }, []);

  useEffect(() => {
    if (loading || pageLoading || pageError || autoBlocked || !cursor || items.length > WINDOW_SIZE) return;
    if (!items.length) { void loadMore(); return; }
    const element = track.current;
    const last = element?.querySelector('[data-gallery-card]:last-child');
    if (!element || !last) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: element, rootMargin: `0px ${Math.ceil(element.clientWidth)}px 0px 0px` });
    observer.observe(last);
    return () => observer.disconnect();
  }, [items, loading, pageLoading, pageError, autoBlocked, cursor, loadMore, track]);

  return { items, loading, error, pageLoading, pageError, activeSequence, setActive,
    hasMore: !!cursor, loadMore, removeImage, imageReady, beginScroll, retry: () => setReload(value => value + 1) };
}
