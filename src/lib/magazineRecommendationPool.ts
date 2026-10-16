/**
 * Client loader for the magazine-backed recommendation candidate pool.
 * Prefer real外刊 content over the five demo LIBRARY_ARTICLES stubs.
 * Pool members rotate once per local calendar day (server-seeded).
 */

import type { Article } from '../types';
import { articleContentFingerprint } from './articleContent';
import { isEnglishArticle } from './articleLanguage';
import { getRecommendationPoolRotationDate } from './recommendationPoolRotation';

const DEFAULT_POOL_LIMIT = 48;
/** Soft TTL within the same rotation day (ms). Day change always invalidates. */
const CACHE_TTL_MS = 30 * 60_000;

export interface MagazineRecommendationPoolResult {
  articles: Article[];
  source: 'magazine' | 'empty' | 'error';
  errorMessage?: string;
  /** Local calendar day this pool was built for (YYYY-MM-DD). */
  rotationDate?: string;
  universeSize?: number;
}

let cachedPool: Article[] | null = null;
let cachedRotationDate: string | null = null;
let cachedAt = 0;
let inflight: Promise<MagazineRecommendationPoolResult> | null = null;

export function clearMagazineRecommendationPoolCache(): void {
  cachedPool = null;
  cachedRotationDate = null;
  cachedAt = 0;
  inflight = null;
}

function isCacheValidForToday(now: Date = new Date()): boolean {
  if (!cachedPool || !cachedRotationDate) return false;
  const today = getRecommendationPoolRotationDate(now);
  if (cachedRotationDate !== today) return false;
  if (Date.now() - cachedAt > CACHE_TTL_MS) return false;
  return true;
}

export function getCachedMagazineRecommendationPool(): Article[] {
  if (!isCacheValidForToday()) return [];
  return cachedPool ?? [];
}

/**
 * Fetch (or reuse) a capped set of full magazine articles for ranking.
 * Cache is keyed by rotation day so the pool refreshes after midnight.
 */
export async function fetchMagazineRecommendationPool(
  limit = DEFAULT_POOL_LIMIT,
  options?: { force?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal; now?: Date }
): Promise<MagazineRecommendationPoolResult> {
  const force = options?.force === true;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const now = options?.now ?? new Date();

  if (!force && isCacheValidForToday(now) && cachedPool) {
    return {
      articles: cachedPool,
      source: cachedPool.length ? 'magazine' : 'empty',
      rotationDate: cachedRotationDate ?? undefined,
    };
  }

  if (!force && inflight) {
    return inflight;
  }

  const request = (async (): Promise<MagazineRecommendationPoolResult> => {
    try {
      const capped = Math.max(1, Math.min(120, Math.floor(limit) || DEFAULT_POOL_LIMIT));
      const res = await fetchImpl(
        `/api/magazines/recommendation-candidates?limit=${capped}`,
        { signal: options?.signal }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          articles: isCacheValidForToday(now) ? (cachedPool ?? []) : [],
          source: 'error',
          errorMessage: text || `HTTP ${res.status}`,
          rotationDate: cachedRotationDate ?? undefined,
        };
      }
      const data = (await res.json()) as {
        ok?: boolean;
        articles?: Article[];
        rotationDate?: string;
        universeSize?: number;
        error?: { message?: string };
      };
      if (!data.ok || !Array.isArray(data.articles)) {
        return {
          articles: isCacheValidForToday(now) ? (cachedPool ?? []) : [],
          source: 'error',
          errorMessage: data.error?.message || 'Invalid recommendation pool response',
          rotationDate: cachedRotationDate ?? undefined,
        };
      }
      const articles = data.articles.filter(
        (article) =>
          article
          && typeof article.id === 'string'
          && Array.isArray(article.content)
          && article.content.length > 0
      );
      const rotationDate =
        typeof data.rotationDate === 'string' && data.rotationDate
          ? data.rotationDate
          : getRecommendationPoolRotationDate(now);

      cachedPool = articles;
      cachedRotationDate = rotationDate;
      cachedAt = Date.now();
      return {
        articles,
        source: articles.length ? 'magazine' : 'empty',
        rotationDate,
        universeSize: data.universeSize,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      return {
        articles: isCacheValidForToday(now) ? (cachedPool ?? []) : [],
        source: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        rotationDate: cachedRotationDate ?? undefined,
      };
    } finally {
      inflight = null;
    }
  })();

  inflight = request;
  return request;
}

/**
 * Merge magazine pool + built-in library + reading history into one ranked pool.
 * History wins on id collisions so Completed status is respected.
 */
export function buildRecommendationArticlePool(
  magazineArticles: readonly Article[],
  libraryArticles: readonly Article[],
  historyArticles: readonly Article[]
): Article[] {
  const byId = new Map<string, Article>();
  const magazineIdByFingerprint = new Map<string, string>();
  const isMagazineArticle = (article: Article) =>
    article.source === 'magazine' || article.id.startsWith('mag:');

  for (const article of magazineArticles) {
    if (!article?.id) continue;
    const fingerprint = articleContentFingerprint(article);
    if (fingerprint && magazineIdByFingerprint.has(fingerprint)) continue;
    byId.set(article.id, article);
    if (fingerprint) magazineIdByFingerprint.set(fingerprint, article.id);
  }
  for (const article of libraryArticles) {
    if (article?.id && !byId.has(article.id)) byId.set(article.id, article);
  }
  // History overlays status / enrichment without dropping magazine content when
  // history rows are thinner stubs — prefer the richer content payload.
  for (const article of historyArticles) {
    if (!article?.id) continue;
    const canonicalId = isMagazineArticle(article)
      ? magazineIdByFingerprint.get(articleContentFingerprint(article))
      : undefined;
    const existingId = byId.has(article.id) ? article.id : canonicalId;
    const existing = existingId ? byId.get(existingId) : undefined;
    if (!existing) {
      byId.set(article.id, article);
      if (isMagazineArticle(article)) {
        const fingerprint = articleContentFingerprint(article);
        if (fingerprint && !magazineIdByFingerprint.has(fingerprint)) {
          magazineIdByFingerprint.set(fingerprint, article.id);
        }
      }
      continue;
    }
    const existingLen = existing.content?.join(' ').length ?? 0;
    const nextLen = article.content?.join(' ').length ?? 0;
    byId.set(existingId!, {
      ...existing,
      ...article,
      id: existing.id,
      content: nextLen >= existingLen ? article.content : existing.content,
      keyWords: article.keyWords?.length ? article.keyWords : existing.keyWords,
      paragraphTranslations:
        article.paragraphTranslations?.length
          ? article.paragraphTranslations
          : existing.paragraphTranslations,
      levelRating: article.levelRating ?? existing.levelRating,
      level: article.level || existing.level,
    });
  }

  return Array.from(byId.values()).filter(isEnglishArticle);
}
