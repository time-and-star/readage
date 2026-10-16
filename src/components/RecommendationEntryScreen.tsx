import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { AppPageHeader } from './AppPageHeader';
import { GalleryStory } from './GalleryStory';
import type { Article, MagazineGalleryItem } from '../types';
import { useGalleryStream } from '../lib/useGalleryStream';

interface RecommendationEntryScreenProps {
  isLoading: boolean;
  phase: 'local' | 'ai' | null;
  feedEnded: boolean;
  onStartRecommendation: () => void;
  onContinueRecommendation?: () => void;
  onSelectArticle?: (article: Article) => void;
  onOpenLibrary: () => void;
  onBack: () => void;
  navigation: React.ReactNode;
}

export const RecommendationEntryScreen: React.FC<RecommendationEntryScreenProps> = ({
  isLoading, onStartRecommendation,
  onContinueRecommendation, onSelectArticle, onOpenLibrary, onBack, navigation,
}) => {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const opening = useRef<AbortController | null>(null);
  const pendingMove = useRef<number | null>(null);
  const { items: visibleItems, loading: galleryLoading, error: galleryError, pageLoading, pageError,
    activeSequence, setActive, hasMore, loadMore, removeImage, imageReady, beginScroll, retry } = useGalleryStream(track);
  const position = Math.max(0, visibleItems.findIndex(item => item.sequence === activeSequence));
  useEffect(() => () => opening.current?.abort(), []);
  useEffect(() => {
    const element = track.current;
    const last = element?.querySelector<HTMLElement>('[data-gallery-card]:last-child');
    if (!element || !last) return;
    // The exhibits have different widths; leave exactly enough room to align the last one.
    const resize = () => {
      element.style.paddingRight = `${Math.max(0, element.clientWidth - last.offsetWidth - 8)}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    observer.observe(last);
    return () => observer.disconnect();
  }, [visibleItems, galleryLoading]);

  const syncPosition = () => {
    const element = track.current;
    if (!element) return;
    const cards = Array.from(element.querySelectorAll('[data-gallery-card]')) as HTMLElement[];
    if (!cards.length) return;
    beginScroll();
    const nearest = cards.reduce<number>((best, card, i) =>
      Math.abs(card.offsetLeft - cards[0].offsetLeft - element.scrollLeft)
        < Math.abs(cards[best].offsetLeft - cards[0].offsetLeft - element.scrollLeft) ? i : best, 0);
    setActive(visibleItems[nearest]?.sequence ?? null);
  };
  const moveTo = (index: number) => {
    pendingMove.current = null;
    const element = track.current;
    const cards = element?.querySelectorAll<HTMLElement>('[data-gallery-card]');
    if (!element || !cards?.length) return;
    const next = Math.max(0, Math.min(cards.length - 1, index));
    beginScroll();
    element.scrollTo({ left: cards[next].offsetLeft - cards[0].offsetLeft,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const move = (direction: number) => {
    if (direction > 0 && position >= visibleItems.length - 1 && hasMore) {
      pendingMove.current = (visibleItems[visibleItems.length - 1]?.sequence ?? 0) + 1;
      void loadMore(); return;
    }
    moveTo(position + direction);
    if (direction > 0 && position >= visibleItems.length - 3 && hasMore) void loadMore();
  };
  useEffect(() => {
    if (pendingMove.current !== null) {
      const next = visibleItems.findIndex(item => item.sequence >= pendingMove.current!);
      if (next >= 0) moveTo(next);
    }
  }, [visibleItems]);
  const openArticle = async (item: MagazineGalleryItem) => {
    if (!onSelectArticle || openingId) return;
    const controller = new AbortController();
    opening.current = controller;
    setOpeningId(item.articleId); setOpenError(null);
    try {
      const response = await fetch(`/api/magazines/articles/${encodeURIComponent(item.articleId)}`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !data.ok || data.article?.id !== item.articleId || !data.article.content?.length) {
        throw new Error('这篇文章暂时无法打开，请再试一次。');
      }
      if (!controller.signal.aborted) onSelectArticle(data.article);
    } catch (error) {
      if (!controller.signal.aborted) setOpenError(error instanceof Error ? error.message : '文章暂时无法打开。');
    } finally {
      if (!controller.signal.aborted) setOpeningId(null);
      if (opening.current === controller) opening.current = null;
    }
  };

  const shownPosition = Math.min(position, Math.max(0, visibleItems.length - 1));

  return <>
    <AppPageHeader onBack={onBack} navigation={navigation} />
    <main className="reading-gallery safe-pb">
      <div className="reading-gallery__inner">
        <section className="reading-gallery__intro" aria-label="推荐阅读">
          <div className="reading-gallery__actions" aria-busy={isLoading}>
            <button type="button" className="reading-gallery__recommend" disabled={isLoading || !!openingId}
              onClick={onContinueRecommendation || onStartRecommendation}>
              {isLoading ? '正在选文…' : onContinueRecommendation ? '继续推荐阅读' : '为我选一篇'}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
            {onContinueRecommendation && <button type="button" className="reading-gallery__text-action"
              disabled={isLoading || !!openingId} onClick={onStartRecommendation}>重新推荐</button>}
            <button type="button" className="reading-gallery__text-action" onClick={onOpenLibrary}>浏览全部杂志</button>
          </div>
        </section>

        <section className="reading-gallery__collection" aria-label="杂志图片画廊">
          <div className="reading-gallery__collection-heading">
            <p>来自你的杂志藏书</p>
            {!galleryLoading && visibleItems.length > 0 && <div className="reading-gallery__paging">
              <span aria-live="polite" aria-label={`当前第 ${activeSequence ?? 1} 张图片`}>{String(activeSequence ?? 1).padStart(2, '0')}</span>
              <button type="button" aria-label="上一张杂志图片" disabled={shownPosition === 0} onClick={() => move(-1)}><ArrowLeft size={18} /></button>
              <button type="button" aria-label="下一张杂志图片" disabled={shownPosition >= visibleItems.length - 1 && !hasMore} onClick={() => move(1)}><ArrowRight size={18} /></button>
            </div>}
          </div>
          {galleryLoading || (!visibleItems.length && hasMore && !pageError) ? <div className="reading-gallery__skeletons" role="status" aria-label="正在准备杂志图片">
            {[0, 1, 2].map(i => <div className="reading-gallery__skeleton" key={i} />)}
          </div> : galleryError ? <div className="reading-gallery__empty" role="alert">
            <p>{galleryError}</p><button type="button" onClick={retry}>重新加载</button>
          </div> : !visibleItems.length ? <div className="reading-gallery__empty">
            <p>还没有可展示的杂志图片。导入带插图的杂志后，故事会在这里展开。</p>
            <button type="button" onClick={onOpenLibrary}>去 Library 选一本杂志</button>
          </div> : <div ref={track} className="reading-gallery__track" onScroll={syncPosition}
            onPointerDown={() => { pendingMove.current = null; beginScroll(); }} onWheel={() => { pendingMove.current = null; beginScroll(); }}
            tabIndex={0} aria-label="左右滑动浏览杂志图片"
            onKeyDown={event => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1);
              }
              if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault(); moveTo(event.key === 'Home' ? 0 : visibleItems.length - 1);
              }
            }}>
            {visibleItems.map((item, index) => <GalleryStory key={item.sequence} item={item} eager={index < 3}
              disabled={!!openingId || !onSelectArticle} opening={openingId === item.articleId}
              onFocus={syncPosition} onOpen={() => void openArticle(item)}
              onImageReady={imageReady} onImageError={() => removeImage(item.image.src)} />)}
          </div>}
          {pageLoading && <p className="reading-gallery__load-status" role="status">正在准备更多图片…</p>}
          {pageError && <div className="reading-gallery__load-status" role="alert">
            <span>{pageError}</span> <button type="button" onClick={() => visibleItems.length ? void loadMore() : retry()}>再试一次</button>
          </div>}
          {openError && <p className="reading-gallery__open-error" role="alert">{openError}</p>}
        </section>
      </div>
    </main>
  </>;
};
