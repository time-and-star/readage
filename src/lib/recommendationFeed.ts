import type { Article } from '../types';

export interface RecommendationRequest {
  topic: string;
  reviewWords: string[];
  excludeArticleIds: string[];
}

export type RecommendationProvider = (request: RecommendationRequest) => Promise<Article>;

export type RecommendationFeedStatus = 'inactive' | 'active' | 'ended';

export interface RecommendationFeedState {
  status: RecommendationFeedStatus;
  queuedArticle: Article | null;
  isPrefetching: boolean;
  seenArticleIds: string[];
}

export function createInactiveRecommendationFeed(): RecommendationFeedState {
  return {
    status: 'inactive',
    queuedArticle: null,
    isPrefetching: false,
    seenArticleIds: [],
  };
}

export function startRecommendationFeed(currentArticleId: string): RecommendationFeedState {
  return {
    status: 'active',
    queuedArticle: null,
    isPrefetching: false,
    seenArticleIds: currentArticleId ? [currentArticleId] : [],
  };
}

export function beginRecommendationPrefetch(
  state: RecommendationFeedState
): RecommendationFeedState {
  if (state.status !== 'active' || state.isPrefetching || state.queuedArticle) return state;
  return { ...state, isPrefetching: true };
}

export function finishRecommendationPrefetch(
  state: RecommendationFeedState,
  article: Article
): RecommendationFeedState {
  if (state.status !== 'active') return { ...state, isPrefetching: false };
  if (state.queuedArticle || state.seenArticleIds.includes(article.id)) {
    return { ...state, isPrefetching: false };
  }
  return { ...state, queuedArticle: article, isPrefetching: false };
}

export function failRecommendationPrefetch(
  state: RecommendationFeedState
): RecommendationFeedState {
  return { ...state, isPrefetching: false };
}

export function markRecommendationArticleSeen(
  state: RecommendationFeedState,
  articleId: string
): RecommendationFeedState {
  if (!articleId || state.seenArticleIds.includes(articleId)) return state;
  return { ...state, seenArticleIds: [...state.seenArticleIds, articleId] };
}

export function consumeQueuedRecommendation(
  state: RecommendationFeedState
): { state: RecommendationFeedState; article: Article | null } {
  const article = state.queuedArticle;
  if (!article) return { state, article: null };
  return {
    article,
    state: markRecommendationArticleSeen({ ...state, queuedArticle: null }, article.id),
  };
}

/**
 * Keep the continuous reader bounded to the article in view and one ready
 * successor. Older recommendations are closed once the reader advances.
 */
export function getRecommendationRenderWindow(
  currentArticle: Article,
  queuedArticle: Article | null,
): Article[] {
  if (!queuedArticle || queuedArticle.id === currentArticle.id) return [currentArticle];
  return [currentArticle, queuedArticle];
}

export function endRecommendationFeed(
  state: RecommendationFeedState
): RecommendationFeedState {
  return {
    ...state,
    status: 'ended',
    queuedArticle: null,
    isPrefetching: false,
  };
}

export function selectLibraryFallback(
  library: Article[],
  history: Article[],
  excludedArticleIds: ReadonlySet<string>,
  isEligible: (article: Article) => boolean = () => true,
  allowCompleted = false,
): Article | null {
  const storedById = new Map(history.map((article) => [article.id, article]));
  return library.find((candidate) => {
    if (excludedArticleIds.has(candidate.id)) return false;
    const stored = storedById.get(candidate.id);
    return (allowCompleted || (stored?.status ?? candidate.status) !== 'Completed')
      && isEligible(candidate);
  }) ?? null;
}

/**
 * Explicit feed-session excludes, plus history when the caller wants normal
 * recommendations to avoid previously opened pieces.
 */
export function collectExcludedArticleIds(
  explicitExcludeIds: readonly string[],
  history: readonly Article[],
  excludeHistory = true,
): Set<string> {
  const excluded = new Set<string>();
  for (const id of explicitExcludeIds) {
    if (id) excluded.add(id);
  }
  if (excludeHistory) {
    for (const article of history) {
      if (article?.id) excluded.add(article.id);
    }
  }
  return excluded;
}
