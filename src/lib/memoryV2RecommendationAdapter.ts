/**
 * Memory V2.2 推荐系统适配器
 * 将 Memory V2.2 推荐引擎集成到现有的推荐接口中
 */

import type { Article } from '../types';
import type { RecommendationRequest } from './recommendationFeed';
import {
  RecommendationEngine,
  ArticleCandidate,
  RecommendationScore,
  countUniqueReviewHits,
  scheduleReviewArticles,
  scoreArticlesForReview,
  diversifyRecommendations,
} from './memoryV2/recommendation';
import { memoryV2 } from './memoryV2/hooks';
import { getNewLemmas } from './readingExposure';
import { toLemma } from './proficiency';
import type { WordProficiencyView } from './memoryV2/memorySystem';
import {
  projectBandsOntoCatalog,
  type CefrRecommendationProfile,
} from './userReadingProfile';
import type { RecommendationParams } from './memoryV2/recommendation';
import { scoreArticleOpportunity } from './memoryV4';
import {
  rerankRecommendationScoresV5,
  type V5RecommendationProfile,
} from './recommendationV5';

/**
 * 从文章中提取所有 lemmas
 */
function extractLemmasFromArticle(article: Article): string[] {
  const allLemmas = new Set<string>();
  const exposedSet = new Set<string>();

  for (const paragraph of article.content) {
    const newLemmas = getNewLemmas(paragraph, exposedSet);
    newLemmas.forEach(lemma => {
      allLemmas.add(lemma);
      exposedSet.add(lemma);
    });
  }

  return Array.from(allLemmas);
}

/**
 * 将文章库转换为候选文章列表
 */
function convertToArticleCandidates(articles: Article[]): ArticleCandidate[] {
  return articles.map(article => ({
    article,
    lemmas: extractLemmasFromArticle(article),
  }));
}

function applyOpportunityRanking(
  recommendations: RecommendationScore[],
  candidates: ArticleCandidate[],
  proficiencyMap: Map<string, WordProficiencyView>,
  v5Profile?: V5RecommendationProfile,
): RecommendationScore[] {
  const opportunityByWord = new Map<string, number>();
  for (const [wordId, proficiency] of proficiencyMap) {
    const opportunity = proficiency.opportunityScore;
    if (typeof opportunity === 'number' && Number.isFinite(opportunity) && opportunity > 0) {
      opportunityByWord.set(toLemma(wordId), opportunity);
    }
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.article.id, candidate]));

  const ranked = recommendations
    .map((recommendation) => {
      const candidate = candidateById.get(recommendation.articleId);
      if (!candidate) return recommendation;
      const scored = scoreArticleOpportunity({
        lemmas: candidate.lemmas,
        opportunityByWord,
        cefrScore: recommendation.cefrScore,
        // Keep existing engine signals as a bounded secondary tie-breaker.
        topicScore: Math.max(0, recommendation.score) * 0.25,
      });
      return {
        ...recommendation,
        score: scored.articleScore,
        opportunityCoverage: scored.opportunityCoverage,
        reason: scored.opportunityCoverage > 0
          ? `${recommendation.reason || '推荐'} · ${scored.coveredWords.length} 个高机会词`
          : recommendation.reason,
      };
    })
    .sort((left, right) => right.score - left.score);

  if (!v5Profile) return ranked;

  const v5Candidates = ranked.map((recommendation) => {
    const candidate = candidateById.get(recommendation.articleId);
    return {
      articleId: recommendation.articleId,
      opportunityCoverage: recommendation.opportunityCoverage
        ?? (recommendation.dueWordsCount * 40),
      topic: candidate?.article.topic,
      level: candidate?.article.levelRating?.level
        || candidate?.article.level
        || candidate?.article.rewriteTargetLevel,
      estimatedWordCount: candidate?.article.estimatedWordCount,
    };
  });
  return rerankRecommendationScoresV5(ranked, v5Candidates, v5Profile);
}

/**
 * 基于 Memory V2.2 的推荐策略
 */
export type RecommendationStrategy =
  | 'balanced'      // 平衡学习区和复习区
  | 'review-first'  // 优先复习到期单词
  | 'learn-first'   // 优先学习新内容
  | 'consolidate';  // 优先巩固已学内容

export interface MemoryV2RecommendationOptions {
  /** 推荐策略 */
  strategy?: RecommendationStrategy;
  /** 返回的推荐数量 */
  limit?: number;
  /** 用户当前 CEFR 等级 */
  userLevel?: string;
  /** 用户偏好的主题 */
  preferredTopics?: string[];
  /** 最小学习区单词数 */
  minLearningZoneWords?: number;
  /** 最大未知单词占比 */
  maxUnknownWordsRatio?: number;
  /** 最近阅读的文章 ID（用于多样性推荐） */
  recentArticleIds?: string[];
  /** 多样性窗口大小 */
  diversityWindow?: number;
  /**
   * When false, skip hard candidate filtering and rely on score penalties only.
   * Preferred for full magazine catalogs (C1 text + sparse personal memory).
   */
  applyHardFilters?: boolean;
  /** Assessment-derived CEFR profile shared by all recommendation paths. */
  cefrProfile?: CefrRecommendationProfile;
  /** Explicit CEFR weight override for compatibility with engine callers. */
  cefrWeight?: number;
  /** Effective catalog bands; computed when omitted. */
  allowedBands?: import('./articleLevel').CefrBand[];
  /** Enable the reversible CEFR candidate window for assessed users. */
  cefrHardFilter?: boolean;
  /** Minimum candidates required before keeping the CEFR window. */
  minCandidatesAfterCefrFilter?: number;
  /** Opt-in V5 multi-objective ranking profile. */
  v5Profile?: V5RecommendationProfile;
}

/**
 * Memory V2.2 推荐适配器
 */
export class MemoryV2RecommendationAdapter {
  private strategy: RecommendationStrategy;
  private engineOptions: RecommendationParams;
  private v5Profile?: V5RecommendationProfile;

  constructor(options: MemoryV2RecommendationOptions = {}) {
    const {
      strategy = 'balanced',
      userLevel = 'B1',
      preferredTopics = [],
      minLearningZoneWords = 5,
      maxUnknownWordsRatio = 0.3,
    } = options;

    this.strategy = strategy;
    this.v5Profile = options.v5Profile;
    const weights = this.getStrategyWeights(strategy);
    this.engineOptions = {
      userLevel,
      preferredTopics,
      prioritizeDueWords: weights.prioritizeDueWords,
      learningZoneWeight: weights.learningZoneWeight,
      consolidationZoneWeight: weights.consolidationZoneWeight,
      dueWordsWeight: weights.dueWordsWeight,
      minLearningZoneWords,
      maxUnknownWordsRatio,
      cefrProfile: options.cefrProfile,
      cefrWeight: options.cefrWeight,
      allowedBands: options.allowedBands,
      cefrHardFilter: options.cefrHardFilter,
      minCandidatesAfterCefrFilter: options.minCandidatesAfterCefrFilter,
    };
  }

  private createEngine(options: MemoryV2RecommendationOptions = {}): RecommendationEngine {
    const strategy = options.strategy ?? this.strategy;
    const weights = this.getStrategyWeights(strategy);
    return new RecommendationEngine({
      ...this.engineOptions,
      ...weights,
      userLevel: options.userLevel ?? this.engineOptions.userLevel,
      preferredTopics: options.preferredTopics ?? this.engineOptions.preferredTopics,
      minLearningZoneWords: options.minLearningZoneWords ?? this.engineOptions.minLearningZoneWords,
      maxUnknownWordsRatio: options.maxUnknownWordsRatio ?? this.engineOptions.maxUnknownWordsRatio,
      cefrProfile: options.cefrProfile ?? this.engineOptions.cefrProfile,
      cefrWeight: options.cefrWeight ?? this.engineOptions.cefrWeight,
      allowedBands: options.allowedBands ?? this.engineOptions.allowedBands,
      cefrHardFilter: options.cefrHardFilter ?? this.engineOptions.cefrHardFilter,
      minCandidatesAfterCefrFilter:
        options.minCandidatesAfterCefrFilter ?? this.engineOptions.minCandidatesAfterCefrFilter,
    });
  }

  /**
   * 根据策略获取权重配置
   */
  private getStrategyWeights(strategy: RecommendationStrategy) {
    switch (strategy) {
      case 'review-first':
        return {
          prioritizeDueWords: true,
          learningZoneWeight: 2.0,
          consolidationZoneWeight: 3.0,
          dueWordsWeight: 8.0,
        };
      case 'learn-first':
        return {
          prioritizeDueWords: false,
          learningZoneWeight: 5.0,
          consolidationZoneWeight: 1.0,
          dueWordsWeight: 2.0,
        };
      case 'consolidate':
        return {
          prioritizeDueWords: false,
          learningZoneWeight: 1.0,
          consolidationZoneWeight: 5.0,
          dueWordsWeight: 3.0,
        };
      case 'balanced':
      default:
        return {
          prioritizeDueWords: true,
          learningZoneWeight: 3.0,
          consolidationZoneWeight: 2.0,
          dueWordsWeight: 5.0,
        };
    }
  }

  /**
   * Rank pre-built ArticleCandidate rows (e.g. full magazine lemma index).
   * Avoids re-tokenizing article bodies on every recommend click.
   */
  async recommendCandidates(
    articleCandidates: ArticleCandidate[],
    options: MemoryV2RecommendationOptions = {}
  ): Promise<RecommendationScore[]> {
    const {
      limit = 5,
      recentArticleIds = [],
      diversityWindow = 5,
      applyHardFilters = true,
    } = options;

    const availableLevels = articleCandidates.map(
      (candidate) => candidate.article.levelRating?.level
        || candidate.article.level
        || candidate.article.rewriteTargetLevel
    );
    const effectiveBands = options.allowedBands
      ?? this.engineOptions.allowedBands
      ?? (this.engineOptions.cefrProfile
        ? projectBandsOntoCatalog(this.engineOptions.cefrProfile.idealBands, availableLevels)
        : undefined);
    const engine = this.createEngine({
      ...options,
      allowedBands: effectiveBands,
      // Local pools use the CEFR window only when the caller keeps hard filters on.
      cefrHardFilter: applyHardFilters
        ? options.cefrHardFilter ?? this.engineOptions.cefrHardFilter ?? Boolean(this.engineOptions.cefrProfile?.useLevelFilter)
        : false,
    });

    const userId = memoryV2.getUserId();
    const system = memoryV2.getSystem();
    const allProficiency = await system.getAllWordProficiency(userId);
    const proficiencyMap = new Map(
      allProficiency.map((p) => [p.wordId, p])
    );

    const filtered = applyHardFilters
      ? engine.filterCandidates(articleCandidates, proficiencyMap)
      : articleCandidates.filter((candidate) => candidate.lemmas.length > 0);

    let recommendations = engine.recommend(
      filtered,
      proficiencyMap,
      Math.max(filtered.length, limit)
    );
    recommendations = applyOpportunityRanking(
      recommendations,
      filtered,
      proficiencyMap,
      options.v5Profile ?? this.v5Profile,
    );

    if (recentArticleIds.length > 0) {
      const articlesMap = new Map(
        articleCandidates.map((candidate) => [candidate.article.id, candidate.article])
      );
      recommendations = diversifyRecommendations(
        recommendations,
        articlesMap,
        recentArticleIds,
        diversityWindow
      );
    }

    return recommendations.slice(0, limit);
  }

  /**
   * 推荐文章
   */
  async recommend(
    candidates: Article[],
    options: MemoryV2RecommendationOptions = {}
  ): Promise<RecommendationScore[]> {
    const articleCandidates = convertToArticleCandidates(candidates);
    return this.recommendCandidates(articleCandidates, options);
  }

  /**
   * 推荐复习文章
   * 专门为到期单词推荐包含这些单词的文章
   */
  async recommendForReview(
    candidates: Article[],
    targetWords?: readonly string[],
    limit?: number
  ): Promise<RecommendationScore[]>;
  async recommendForReview(
    candidates: Article[],
    targetReviewCount?: number,
    limit?: number
  ): Promise<RecommendationScore[]>;
  async recommendForReview(
    candidates: Article[],
    targetWordsOrCount: readonly string[] | number = 10,
    limit: number = 5
  ): Promise<RecommendationScore[]> {
    const userId = memoryV2.getUserId();
    const system = memoryV2.getSystem();
    const explicitTargetWords = Array.isArray(targetWordsOrCount)
      ? Array.from(
          new Set(
            targetWordsOrCount
              .map(toLemma)
              .filter(Boolean)
          )
        )
      : [];
    const targetReviewCount = typeof targetWordsOrCount === 'number'
      ? targetWordsOrCount
      : explicitTargetWords.length > 0
        ? explicitTargetWords.length
        : 10;

    const allProficiency = await system.getAllWordProficiency(userId);
    const proficiencyMap = new Map(
      allProficiency.map(p => [p.wordId, p])
    );

    let priorityWords: WordProficiencyView[];
    if (explicitTargetWords.length > 0) {
      // Explicit targets take precedence and must not trigger a due-word query.
      priorityWords = explicitTargetWords.map(wordId => {
        const existing = proficiencyMap.get(wordId);
        if (existing) return existing;

        // A requested word may not have memory state yet, but it is still a valid target.
        const target: WordProficiencyView = {
          wordId,
          memoryScore: 0,
          level: 0,
          stability: 0,
          difficulty: 0,
          nextReview: new Date(0).toISOString(),
          lastReview: null,
        };
        proficiencyMap.set(wordId, target);
        return target;
      });
    } else {
      // Preserve the legacy behavior when no concrete target set is supplied.
      priorityWords = await system.getDueWords(userId, new Date(), targetReviewCount);
    }

    if (priorityWords.length === 0) {
      return this.recommend(candidates, { limit });
    }

    const articleCandidates = convertToArticleCandidates(candidates);
    // Unique-hit schedule first (drops zero-hit articles).
    const reviewArticles = scheduleReviewArticles(
      priorityWords,
      articleCandidates,
      targetReviewCount
    );

    if (reviewArticles.length === 0) {
      return this.recommend(candidates, { limit });
    }

    // Hit rate dominates ranking; engine score only breaks ties / fine-tunes.
    const targetIds = priorityWords.map((word) => word.wordId);
    const availableLevels = articleCandidates.map(
      (candidate) => candidate.article.levelRating?.level
        || candidate.article.level
        || candidate.article.rewriteTargetLevel
    );
    const effectiveBands = this.engineOptions.allowedBands
      ?? (this.engineOptions.cefrProfile
        ? projectBandsOntoCatalog(this.engineOptions.cefrProfile.idealBands, availableLevels)
        : undefined);
    const ranked = scoreArticlesForReview(
      reviewArticles,
      targetIds,
      proficiencyMap,
      this.createEngine({ allowedBands: effectiveBands, cefrHardFilter: false }),
      limit
    );
    return applyOpportunityRanking(
      ranked,
      articleCandidates,
      proficiencyMap,
      this.v5Profile,
    ).slice(0, limit);
  }

  /**
   * 更新推荐参数
   */
  updateOptions(options: Partial<MemoryV2RecommendationOptions>): void {
    if (options.strategy) this.strategy = options.strategy;
    if (options.userLevel) {
      this.engineOptions.userLevel = options.userLevel;
    }
    if (options.preferredTopics) {
      this.engineOptions.preferredTopics = options.preferredTopics;
    }
    if (options.minLearningZoneWords !== undefined) {
      this.engineOptions.minLearningZoneWords = options.minLearningZoneWords;
    }
    if (options.maxUnknownWordsRatio !== undefined) {
      this.engineOptions.maxUnknownWordsRatio = options.maxUnknownWordsRatio;
    }
    if (options.cefrProfile !== undefined) this.engineOptions.cefrProfile = options.cefrProfile;
    if (options.cefrWeight !== undefined) this.engineOptions.cefrWeight = options.cefrWeight;
    if (options.allowedBands !== undefined) this.engineOptions.allowedBands = options.allowedBands;
    if (options.cefrHardFilter !== undefined) this.engineOptions.cefrHardFilter = options.cefrHardFilter;
    if (options.minCandidatesAfterCefrFilter !== undefined) {
      this.engineOptions.minCandidatesAfterCefrFilter = options.minCandidatesAfterCefrFilter;
    }
    if (options.v5Profile !== undefined) this.v5Profile = options.v5Profile;
  }
}

/**
 * 创建默认的推荐适配器实例
 */
export function createMemoryV2Adapter(
  options: MemoryV2RecommendationOptions = {}
): MemoryV2RecommendationAdapter {
  return new MemoryV2RecommendationAdapter(options);
}

/**
 * Rank a full magazine lemma catalog and return ordered scores (ids only).
 * Uses soft filtering so C1 magazines are not wiped out by sparse personal memory.
 */
export async function rankMagazineLemmaCandidates(
  candidates: ArticleCandidate[],
  options: MemoryV2RecommendationOptions & {
    reviewWords?: readonly string[];
    excludeArticleIds?: readonly string[];
  } = {}
): Promise<RecommendationScore[]> {
  const {
    reviewWords = [],
    excludeArticleIds = [],
    limit = 20,
    strategy = reviewWords.length > 0 ? 'review-first' : 'balanced',
    ...rest
  } = options;

  const excluded = new Set(excludeArticleIds.filter(Boolean));
  const recentIds = Array.from(excludeArticleIds);
  const filtered = candidates.filter(
    (candidate) => candidate.article.id && !excluded.has(candidate.article.id)
  );
  if (filtered.length === 0) return [];

  const adapter = createMemoryV2Adapter({
    strategy,
    ...rest,
    preferredTopics: rest.preferredTopics,
    recentArticleIds: recentIds,
    // Full-catalog C1 text: hard unknown-ratio filters collapse the pool to ~0.
    applyHardFilters: rest.applyHardFilters ?? false,
    maxUnknownWordsRatio: rest.maxUnknownWordsRatio ?? 0.95,
    minLearningZoneWords: rest.minLearningZoneWords ?? 1,
  });

  if (reviewWords.length > 0) {
    // Prefer articles containing target review lemmas, then score.
    const target = new Set(
      reviewWords.map(toLemma).filter(Boolean)
    );
    const hitById = new Map<string, number>();
    const withTargets = filtered
      .map((candidate) => {
        const hit = countUniqueReviewHits(candidate.lemmas, target);
        hitById.set(candidate.article.id, hit);
        return { candidate, hit };
      })
      .filter((row) => row.hit > 0)
      .sort((a, b) => b.hit - a.hit)
      .map((row) => row.candidate);

    const pool = withTargets.length > 0 ? withTargets : filtered;
    const ranked = await adapter.recommendCandidates(pool, {
      ...rest,
      strategy: 'review-first',
      // Rank a wider head so target-hit boost can surface the best coverage.
      limit: Math.max(limit * 3, 48),
      recentArticleIds: recentIds,
      applyHardFilters: false,
    });

    // Cold-start proficiency maps often give flat base scores; boost by explicit
    // review-word coverage so full-catalog ranking still prefers target hits.
    const boosted = ranked
      .map((score) => {
        const hits = hitById.get(score.articleId) ?? 0;
        return {
          ...score,
          dueWordsCount: Math.max(score.dueWordsCount, hits),
          score: score.score + hits * 40,
          reason:
            hits > 0
              ? `${score.reason || '全库推荐'} · 命中 ${hits} 个复习词`
              : score.reason,
        };
      })
      .sort((a, b) => b.score - a.score);

    return boosted.slice(0, limit);
  }

  return adapter.recommendCandidates(filtered, {
    ...rest,
    strategy,
    limit,
    recentArticleIds: recentIds,
    applyHardFilters: false,
  });
}

/**
 * 将 Memory V2.2 推荐集成到现有的 RecommendationProvider 接口
 */
export async function memoryV2RecommendationProvider(
  request: RecommendationRequest,
  articleLibrary: Article[],
  options: MemoryV2RecommendationOptions = {}
): Promise<Article | null> {
  const { topic, reviewWords, excludeArticleIds } = request;
  const excluded = new Set(excludeArticleIds.filter(Boolean));

  // Drop feed-session excludes and already-finished pieces so the same article
  // is never re-served for review ranking.
  const candidates = articleLibrary.filter((article) => {
    if (!article?.id || excluded.has(article.id)) return false;
    if (article.status === 'Completed') return false;
    return true;
  });

  if (candidates.length === 0) {
    return null;
  }

  // 创建推荐适配器
  const adapter = createMemoryV2Adapter({
    ...options,
    preferredTopics: topic ? [topic] : options.preferredTopics,
    recentArticleIds: excludeArticleIds,
  });

  // 如果有指定复习单词，使用复习推荐
  let recommendations: RecommendationScore[];
  if (reviewWords && reviewWords.length > 0) {
    recommendations = await adapter.recommendForReview(
      candidates,
      reviewWords,
      5
    );
  } else {
    recommendations = await adapter.recommend(candidates, {
      limit: 5,
      recentArticleIds: excludeArticleIds,
    });
  }

  if (recommendations.length === 0) {
    return null;
  }

  // 返回得分最高的文章
  const topRecommendation = recommendations[0];
  const article = candidates.find(a => a.id === topRecommendation.articleId);

  return article || null;
}
