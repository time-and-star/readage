/**
 * Interactive recommendation resolution chain:
 * Full-catalog lemma rank (optional) → Memory V2 local library → library fallback → AI
 */

import type { Article } from '../types';
import type { RecommendedArticleCandidate } from './articleValidation';
import {
  memoryV2RecommendationProvider,
  rankMagazineLemmaCandidates,
  type MemoryV2RecommendationOptions,
} from './memoryV2RecommendationAdapter';
import {
  expandLemmaIndexToCandidates,
  fetchMagazineArticleById,
  fetchMagazineLemmaIndex,
  type MagazineLemmaIndex,
} from './magazineLemmaIndex';
import {
  collectExcludedArticleIds,
  selectLibraryFallback,
} from './recommendationFeed';
import {
  buildCefrRecommendationProfile,
  resolveUserCefrLevel,
  type CefrRecommendationProfile,
} from './userReadingProfile';
import {
  getRecommendationPoolRotationDate,
  seededShuffle,
} from './recommendationPoolRotation';
import { postTutor, type TutorPostOptions } from './tutorClient';
import {
  getArticleWordCount,
  isRecommendationArticleWithinBounds,
  type ArticleCandidate,
  type RecommendationScore,
} from './memoryV2/recommendation';
import type { V5RecommendationProfile } from './recommendationV5';
import {
  emitRecCandidates,
  emitRecCatalogLoaded,
  emitRecPhase,
  emitRecPicked,
  emitRecPoolReady,
  getActiveRecSessionId,
  normalizeReviewWords,
  reviewHitsInLemmas,
  startRecSession,
} from './recommendationTelemetry';

export type RecommendationSource =
  | 'local_memory'
  | 'library_fallback'
  | 'ai'
  | 'timeout_fallback'
  | 'full_catalog';

export interface ResolveRecommendationRequest {
  topic: string;
  reviewWords: string[];
  excludeArticleIds: string[];
}

export interface ResolveRecommendationContext {
  library: Article[];
  history: Article[];
  userLevel?: string;
  cefrProfile?: CefrRecommendationProfile;
  /** Optional V5 multi-objective profile for the next-article ranking layer. */
  v5Profile?: V5RecommendationProfile;
  memoryOptions?: MemoryV2RecommendationOptions;
  /** Optional UI progress hook. */
  onPhase?: (phase: 'local' | 'library' | 'ai' | 'catalog') => void;
  /** Injected for tests; defaults to memoryV2RecommendationProvider. */
  localProvider?: typeof memoryV2RecommendationProvider;
  /** Injected for tests; defaults to postTutor. */
  aiPost?: typeof postTutor;
  /** Injected for tests; defaults to selectLibraryFallback. */
  libraryFallback?: typeof selectLibraryFallback;
  /**
   * When true (default), rank the full magazine lemma index (~658) then hydrate
   * only the winning article body.
   */
  useFullCatalog?: boolean;
  /** Injected catalog loader (tests). */
  loadLemmaIndex?: () => Promise<MagazineLemmaIndex | null>;
  /** Injected article body loader (tests). */
  loadArticleById?: (articleId: string) => Promise<Article | null>;
  /** Injected ranker (tests). */
  rankCatalog?: typeof rankMagazineLemmaCandidates;
  /** Optional timing diagnostics callback. */
  onTiming?: (timing: RecommendationTiming) => void;
}

export interface RecommendationTiming {
  catalogLoadMs?: number;
  rankMs?: number;
  hydrateMs?: number;
  totalMs: number;
  catalogSize?: number;
  source: RecommendationSource | 'miss';
}

export interface ResolvedRecommendation {
  article: Article;
  source: RecommendationSource;
}

/** Real pick diagnostics for particle telemetry (last full-catalog win). */
let lastCatalogPickTelemetry: {
  score?: number;
  rank?: number;
  reviewHits?: string[];
  reason?: string;
} | null = null;

function buildAiArticle(
  data: RecommendedArticleCandidate,
  topic: string,
  reviewWords: string[],
  userLevel: string
): Article {
  return {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: data.title,
    description: data.description,
    date: new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    status: 'In Progress',
    source: 'ai_generated',
    level: userLevel,
    topic,
    content: data.paragraphs,
    keyWords: data.keyWords,
    embeddedReviewWords: reviewWords,
  };
}

/**
 * Among the top ranked scores, apply a stable daily shuffle so the interactive
 * feed explores the head of the list instead of always locking onto #1 when
 * cold-start scores are flat.
 */
export function pickDailyRankedRecommendation(
  scores: readonly RecommendationScore[],
  rotationDate: string,
  exploreTop = 24
): RecommendationScore | null {
  if (scores.length === 0) return null;
  const topScore = scores[0]?.score;
  if (topScore === undefined) return null;
  const head = scores
    .slice(0, Math.max(1, exploreTop))
    .filter((candidate) => candidate.score === topScore);
  const shuffled = seededShuffle(head, `full-catalog-explore:${rotationDate}`);
  return shuffled[0] ?? scores[0] ?? null;
}

async function resolveFromFullCatalog(
  request: ResolveRecommendationRequest,
  context: ResolveRecommendationContext,
  excluded: ReadonlySet<string>,
  expandedExcludeIds: string[],
  timing: Partial<RecommendationTiming>,
  signal?: AbortSignal
): Promise<ResolvedRecommendation | null> {
  const {
    library,
    history,
    userLevel = 'B1',
    cefrProfile,
    v5Profile,
    memoryOptions,
    onPhase,
    loadLemmaIndex,
    loadArticleById,
    rankCatalog = rankMagazineLemmaCandidates,
  } = context;
  const profile = cefrProfile
    ?? memoryOptions?.cefrProfile
    ?? buildCefrRecommendationProfile(
      null,
      resolveUserCefrLevel({ recommendedBand: userLevel })
    );
  const effectiveMemoryOptions: MemoryV2RecommendationOptions = {
    ...memoryOptions,
    userLevel: profile.userLevel,
    cefrProfile: profile,
    v5Profile: v5Profile ?? memoryOptions?.v5Profile,
  };

  onPhase?.('catalog');
  emitRecPhase('catalog');
  const catalogStarted = Date.now();
  let index: MagazineLemmaIndex | null = null;
  if (loadLemmaIndex) {
    index = await loadLemmaIndex();
  } else {
    const loaded = await fetchMagazineLemmaIndex({ signal });
    index = loaded.index;
  }
  timing.catalogLoadMs = Date.now() - catalogStarted;
  timing.catalogSize = index?.articleCount;
  if (typeof timing.catalogSize === 'number' && typeof timing.catalogLoadMs === 'number') {
    emitRecCatalogLoaded(timing.catalogSize, timing.catalogLoadMs);
  }

  if (!index || index.articleCount === 0) return null;

  const catalogArticleCount = index.articleCount;
  const candidates: ArticleCandidate[] = expandLemmaIndexToCandidates(
    index,
    excluded
  );
  // Merge small built-in / history rows that have content but are not in the catalog.
  for (const article of [...library, ...history]) {
    if (!article?.id || excluded.has(article.id)) continue;
    if (candidates.some((row) => row.article.id === article.id)) continue;
    if (!Array.isArray(article.content) || article.content.length === 0) continue;
    // Tokenize only non-catalog extras (usually ≤5 demo + user pastes).
    const { getNewLemmas } = await import('./readingExposure');
    const lemmas = new Set<string>();
    const exposed = new Set<string>();
    for (const paragraph of article.content) {
      for (const lemma of getNewLemmas(paragraph, exposed)) {
        lemmas.add(lemma);
        exposed.add(lemma);
      }
    }
    if (lemmas.size === 0) continue;
    candidates.push({
      article: {
        id: article.id,
        title: article.title,
        content: article.content,
        level: article.level,
        levelRating: article.levelRating,
        rewriteTargetLevel: article.rewriteTargetLevel,
        estimatedWordCount: getArticleWordCount(article) ?? undefined,
        topic: article.topic,
      },
      lemmas: Array.from(lemmas),
    });
  }

  const reviewWords = normalizeReviewWords(request.reviewWords);
  const recommendationMode = reviewWords.length > 0 ? 'review' : 'normal';
  const boundedCandidates = candidates.filter((candidate) =>
    isRecommendationArticleWithinBounds(candidate.article, profile, {
      mode: recommendationMode,
      checkCefr: true,
    })
  );
  if (boundedCandidates.length === 0) return null;

  const poolSize = boundedCandidates.length;
  const excludedCount = Math.max(0, catalogArticleCount - poolSize);
  emitRecPoolReady(poolSize, excludedCount);

  const rankStarted = Date.now();
  const scores = await rankCatalog(boundedCandidates, {
    ...effectiveMemoryOptions,
    reviewWords,
    excludeArticleIds: expandedExcludeIds,
    userLevel: profile.userLevel,
    preferredTopics: request.topic ? [request.topic] : effectiveMemoryOptions.preferredTopics,
    recentArticleIds: expandedExcludeIds,
    limit: 48,
    applyHardFilters: true,
  });
  timing.rankMs = Date.now() - rankStarted;

  const titleById = new Map(
    boundedCandidates.map((row) => [row.article.id, row.article.title || row.article.id] as const)
  );
  const lemmasById = new Map(
    boundedCandidates.map((row) => [row.article.id, row.lemmas] as const)
  );
  // Full pool scored in ranker; only head is returned for pick + visualizer.
  emitRecCandidates(scores, titleById, {
    totalScored: poolSize,
    shortlistSize: scores.length,
    reviewWords,
    lemmasById,
  });

  const rotationDate = getRecommendationPoolRotationDate();
  const picked = pickDailyRankedRecommendation(scores, rotationDate, 24);
  if (!picked) return null;

  const pickRank = scores.findIndex((row) => row.articleId === picked.articleId);
  const pickScore = pickRank >= 0 ? scores[pickRank] : picked;
  const pickHits = reviewHitsInLemmas(
    lemmasById.get(picked.articleId) ?? [],
    reviewWords
  );
  lastCatalogPickTelemetry = {
    score: pickScore.score,
    rank: pickRank >= 0 ? pickRank + 1 : 1,
    reviewHits: pickHits,
    reason: pickScore.reason,
  };

  // Prefer in-memory body when already loaded (history / small library pool).
  const localHit =
    library.find((article) => article.id === picked.articleId)
    || history.find((article) => article.id === picked.articleId);
  if (
    localHit?.content?.length
    && isRecommendationArticleWithinBounds(localHit, profile, { mode: recommendationMode })
  ) {
    return { article: localHit, source: 'full_catalog' };
  }

  const hydrateStarted = Date.now();
  const loader =
    loadArticleById
    ?? ((articleId: string) => fetchMagazineArticleById(articleId, { signal }));
  const article = await loader(picked.articleId);
  timing.hydrateMs = Date.now() - hydrateStarted;
  if (!article) return null;
  if (!isRecommendationArticleWithinBounds(article, profile, {
    mode: recommendationMode,
    checkCefr: false,
  })) {
    return null;
  }
  return { article, source: 'full_catalog' };
}

/**
 * Resolve the next recommendation article without hanging the UI on AI.
 *
 * Order:
 * 1. Full magazine lemma-index ranking (all ~658) + hydrate winner
 * 2. Memory V2 local ranking over the in-memory library pool
 * 3. Simple unread library fallback
 * 4. Budgeted AI generation (only if still nothing)
 *
 * When a local/catalog article exists, AI is never called for the interactive path.
 */
export async function resolveRecommendationArticle(
  request: ResolveRecommendationRequest,
  context: ResolveRecommendationContext,
  tutorOptions?: TutorPostOptions
): Promise<ResolvedRecommendation | null> {
  const started = Date.now();
  const {
    library,
    history,
    userLevel = 'B1',
    cefrProfile,
    v5Profile,
    memoryOptions,
    onPhase,
    localProvider = memoryV2RecommendationProvider,
    aiPost = postTutor,
    libraryFallback = selectLibraryFallback,
    useFullCatalog = true,
    onTiming,
  } = context;
  const profile = cefrProfile
    ?? memoryOptions?.cefrProfile
    ?? buildCefrRecommendationProfile(
      null,
      resolveUserCefrLevel({ recommendedBand: userLevel })
    );
  const effectiveMemoryOptions: MemoryV2RecommendationOptions = {
    ...memoryOptions,
    userLevel: profile.userLevel,
    cefrProfile: profile,
    v5Profile: v5Profile ?? memoryOptions?.v5Profile,
  };
  const { topic, reviewWords, excludeArticleIds } = request;
  const recommendationMode = reviewWords.length > 0 ? 'review' : 'normal';
  const isUsableRecommendation = (article: Article): boolean =>
    isRecommendationArticleWithinBounds(article, profile, { mode: recommendationMode });
  // Never re-recommend pieces the user already opened (history) or saw in this feed.
  const excluded = collectExcludedArticleIds(excludeArticleIds, history);
  const expandedExcludeIds = Array.from(excluded);
  const timing: Partial<RecommendationTiming> = {};

  if (!getActiveRecSessionId()) {
    startRecSession({
      topic,
      reviewWords,
      userLevel: profile.userLevel,
    });
  }

  lastCatalogPickTelemetry = null;

  const emitPicked = (
    article: Article,
    source: RecommendationSource,
    totalMs: number,
    extra?: {
      score?: number;
      rank?: number;
      reviewHits?: string[];
      reason?: string;
    }
  ) => {
    emitRecPicked({
      articleId: article.id,
      title: article.title,
      source,
      totalMs,
      score: extra?.score,
      rank: extra?.rank,
      reviewHits: extra?.reviewHits,
      reason: extra?.reason,
    });
  };

  if (useFullCatalog) {
    try {
      const catalogHit = await resolveFromFullCatalog(
        request,
        {
          ...context,
          userLevel: profile.userLevel,
          cefrProfile: profile,
          memoryOptions: effectiveMemoryOptions,
        },
        excluded,
        expandedExcludeIds,
        timing,
        tutorOptions?.signal
      );
      if (catalogHit) {
        const totalMs = Date.now() - started;
        const finalTiming: RecommendationTiming = {
          ...timing,
          totalMs,
          source: catalogHit.source,
        };
        onTiming?.(finalTiming);
        emitPicked(catalogHit.article, catalogHit.source, totalMs, lastCatalogPickTelemetry ?? undefined);
        return catalogHit;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      console.warn('Full-catalog recommendation failed; falling back to pool ranking.', error);
    }
  }

  onPhase?.('local');
  emitRecPhase('local');
  const localArticle = await localProvider(
    { topic, reviewWords, excludeArticleIds: expandedExcludeIds },
    library,
    {
      ...effectiveMemoryOptions,
      strategy: reviewWords.length > 0 ? 'review-first' : 'balanced',
      userLevel: profile.userLevel,
      cefrProfile: profile,
      preferredTopics: topic ? [topic] : effectiveMemoryOptions.preferredTopics ?? [],
      recentArticleIds: expandedExcludeIds,
    }
  );

  if (localArticle && isUsableRecommendation(localArticle)) {
    const totalMs = Date.now() - started;
    onTiming?.({
      ...timing,
      totalMs,
      source: 'local_memory',
    });
    emitPicked(localArticle, 'local_memory', totalMs);
    return { article: localArticle, source: 'local_memory' };
  }

  onPhase?.('library');
  emitRecPhase('library');
  const libraryArticle = libraryFallback(library, history, excluded);
  if (libraryArticle && isUsableRecommendation(libraryArticle)) {
    const totalMs = Date.now() - started;
    onTiming?.({
      ...timing,
      totalMs,
      source: 'library_fallback',
    });
    emitPicked(libraryArticle, 'library_fallback', totalMs);
    return { article: libraryArticle, source: 'library_fallback' };
  }

  // Only spend the interaction budget on AI when the library has no candidate.
  onPhase?.('ai');
  emitRecPhase('ai');
  try {
    const response = await aiPost<RecommendedArticleCandidate>(
      {
        intent: 'recommend_article',
        topic,
        reviewWords,
        level: profile.userLevel,
      },
      fetch,
      tutorOptions
    );
    const totalMs = Date.now() - started;
    onTiming?.({
      ...timing,
      totalMs,
      source: 'ai',
    });
    const article = buildAiArticle(response.result, topic, reviewWords, profile.userLevel);
    if (!isUsableRecommendation(article)) {
      throw new Error('AI recommendation is outside the active CEFR or length bounds.');
    }
    emitPicked(article, 'ai', totalMs);
    return {
      article,
      source: 'ai',
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    // Last-ditch: re-check library in case history/status changed mid-flight.
    const finalFallback = libraryFallback(library, history, excluded);
    if (finalFallback && isUsableRecommendation(finalFallback)) {
      const totalMs = Date.now() - started;
      onTiming?.({
        ...timing,
        totalMs,
        source: 'timeout_fallback',
      });
      emitPicked(finalFallback, 'timeout_fallback', totalMs);
      return { article: finalFallback, source: 'timeout_fallback' };
    }
    onTiming?.({
      ...timing,
      totalMs: Date.now() - started,
      source: 'miss',
    });
    throw error;
  }
}
