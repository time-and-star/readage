import { useEffect, useMemo, useState } from 'react';
import type { Article, ArticleMedia } from '../types';
import { fetchMagazineArticleById } from './magazineLemmaIndex';
import { alignArticleMedia } from './articleMedia';

type MediaSource = Pick<Article, 'content' | 'media'>;
const mediaCache = new Map<string, MediaSource>();

/** Old saved articles can acquire illustrations without replacing their text or translations. */
export function useArticleMedia(articles: Article[]): Record<string, ArticleMedia[]> {
  const [loaded, setLoaded] = useState<Record<string, MediaSource>>({});
  const missingIds = useMemo(() => JSON.stringify(Array.from(new Set(articles
    .filter(article => article.source === 'magazine' && article.media === undefined)
    .map(article => article.id))).sort()), [articles]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    for (const id of JSON.parse(missingIds) as string[]) {
      const cached = mediaCache.get(id);
      if (cached) {
        setLoaded(previous => ({ ...previous, [id]: cached }));
        continue;
      }
      void fetchMagazineArticleById(id, { signal: controller.signal })
        .then(article => {
          if (!current || !article || article.media === undefined) return;
          const source = { content: article.content, media: article.media };
          mediaCache.set(id, source);
          setLoaded(previous => ({ ...previous, [id]: source }));
        })
        .catch(() => { /* Reading remains available while the local server is unavailable. */ });
    }
    return () => {
      current = false;
      controller.abort();
    };
  }, [missingIds]);

  return useMemo(() => Object.fromEntries(articles.map(article => {
    const source = loaded[article.id] ?? mediaCache.get(article.id);
    return [article.id, article.media ?? (source ? alignArticleMedia(source, article.content) : [])];
  })), [articles, loaded]);
}
