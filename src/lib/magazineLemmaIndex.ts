/**
 * Client cache for the full-catalog magazine lemma index.
 * Enables ranking all ~658 articles without shipping full bodies first.
 */

import type { Article } from '../types';
import type { ArticleCandidate } from './memoryV2/recommendation';
import { isNonStoryArticleTitle } from './articleEligibility';

export interface MagazineLemmaIndexArticle {
  id: string;
  title: string;
  level?: string;
  topic?: string;
  sourceId?: string;
  wordCount?: number;
  lemmaIndices: number[];
}

export interface MagazineLemmaIndex {
  version: number;
  fingerprint: string;
  builtAt: string;
  articleCount: number;
  vocab: string[];
  articles: MagazineLemmaIndexArticle[];
  buildMs?: number;
}

export interface MagazineLemmaIndexResult {
  index: MagazineLemmaIndex | null;
  source: 'network' | 'cache' | 'error' | 'empty';
  loadMs: number;
  errorMessage?: string;
}

let cachedIndex: MagazineLemmaIndex | null = null;
let inflight: Promise<MagazineLemmaIndexResult> | null = null;

export function clearMagazineLemmaIndexCache(): void {
  cachedIndex = null;
  inflight = null;
}

export function getCachedMagazineLemmaIndex(): MagazineLemmaIndex | null {
  return cachedIndex;
}

export function expandLemmaIndexToCandidates(
  index: MagazineLemmaIndex,
  excludeIds?: ReadonlySet<string>
): ArticleCandidate[] {
  const excluded = excludeIds ?? new Set<string>();
  const candidates: ArticleCandidate[] = [];

  for (const row of index.articles) {
    // Cached indexes from older versions can still contain publication directories.
    if (!row?.id || excluded.has(row.id) || isNonStoryArticleTitle(row.title)) continue;
    const lemmas: string[] = [];
    for (const idx of row.lemmaIndices) {
      const word = index.vocab[idx];
      if (word) lemmas.push(word);
    }
    if (lemmas.length === 0) continue;
    candidates.push({
      article: {
        id: row.id,
        title: row.title,
        content: [],
        level: row.level,
        topic: row.topic,
        estimatedWordCount: row.wordCount,
      },
      lemmas,
    });
  }
  return candidates;
}

/**
 * Fetch (or reuse) the full-catalog lemma index from the magazine API.
 */
export async function fetchMagazineLemmaIndex(
  options?: { force?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal; rebuild?: boolean }
): Promise<MagazineLemmaIndexResult> {
  const force = options?.force === true || options?.rebuild === true;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const started = Date.now();

  if (!force && cachedIndex) {
    return {
      index: cachedIndex,
      source: 'cache',
      loadMs: Date.now() - started,
    };
  }
  if (!force && inflight) {
    return inflight;
  }

  const request = (async (): Promise<MagazineLemmaIndexResult> => {
    try {
      const qs = options?.rebuild ? '?rebuild=1' : '';
      const res = await fetchImpl(`/api/magazines/lemma-index${qs}`, {
        signal: options?.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          index: cachedIndex,
          source: 'error',
          loadMs: Date.now() - started,
          errorMessage: text || `HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        ok?: boolean;
        index?: MagazineLemmaIndex;
        error?: { message?: string };
      };
      if (!data.ok || !data.index?.vocab || !data.index?.articles) {
        return {
          index: cachedIndex,
          source: 'error',
          loadMs: Date.now() - started,
          errorMessage: data.error?.message || 'Invalid lemma index response',
        };
      }
      cachedIndex = data.index;
      return {
        index: data.index,
        source: data.index.articleCount > 0 ? 'network' : 'empty',
        loadMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return {
        index: cachedIndex,
        source: 'error',
        loadMs: Date.now() - started,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      inflight = null;
    }
  })();

  inflight = request;
  return request;
}

/** Load a single full magazine article body after ranking. */
export async function fetchMagazineArticleById(
  articleId: string,
  options?: { fetchImpl?: typeof fetch; signal?: AbortSignal; deferMedia?: boolean }
): Promise<Article | null> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `/api/magazines/articles/${encodeURIComponent(articleId)}${options?.deferMedia ? '?media=defer' : ''}`,
    { signal: options?.signal }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { ok?: boolean; article?: Article };
  if (!data.ok || !data.article?.id) return null;
  return data.article;
}
