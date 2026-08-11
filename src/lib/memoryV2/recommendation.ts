/**
 * 文章推荐算法 V2.2
 * 基于 Memory Score �?FSRS 状态的智能推荐
 */

import { WordProficiencyView } from './memorySystem';
import {
  buildCefrRecommendationProfile,
  CEFR_BAND_ORDER,
  getCefrRelation,
  projectBandsOntoCatalog,
  resolveUserCefrLevel,
  suggestedWordCountRange,
  type CefrRecommendationProfile,
  type CefrRelation,
} from '../userReadingProfile';
import { normalizeCefrBand, type CefrBand } from '../articleLevel';
import { toLemma } from '../proficiency';

export interface Article {
  id: string;
  title: string;
  content: string[];
  level?: string;
  levelRating?: { level?: string; estimatedWordCount?: number };
  rewriteTargetLevel?: string;
  topic?: string;
  estimatedWordCount?: number;
}

export interface ArticleCandidate {
  article: Article;
  /** 文章中的所有词形还原后的单词列�?*/
  lemmas: string[];
}

export type RecommendationMode = 'normal' | 'review';

export const RECOMMENDATION_WORD_COUNT_LIMITS: Record<RecommendationMode, number> = {
  normal: 600,
  review: 800,
};

export function getArticleWordCount(
  article: Pick<Article, 'content' | 'estimatedWordCount' | 'levelRating'>
): number | null {
  const estimated = article.estimatedWordCount ?? article.levelRating?.estimatedWordCount;
  if (typeof estimated === 'number' && Number.isFinite(estimated) && estimated > 0) {
    return estimated;
  }

  const actual = article.content
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
  return actual > 0 ? actual : null;
}

export function isRecommendationArticleWithinBounds(
  article: Pick<Article, 'content' | 'estimatedWordCount' | 'levelRating' | 'level' | 'rewriteTargetLevel'>,
  profile: CefrRecommendationProfile,
  options: {
    mode?: RecommendationMode;
    checkCefr?: boolean;
    allowedBands?: readonly CefrBand[];
  } = {},
): boolean {
  const mode = options.mode ?? 'normal';
  const wordCount = getArticleWordCount(article);
  if (wordCount !== null && wordCount > RECOMMENDATION_WORD_COUNT_LIMITS[mode]) {
    return false;
  }

  if (options.checkCefr === false) return true;
  const level = normalizeCefrBand(
    article.levelRating?.level || article.level || article.rewriteTargetLevel
  );
  if (!level) return true;
  const allowed = options.allowedBands?.length
    ? options.allowedBands
    : profile.idealBands.length > 0
      ? [
          ...profile.idealBands,
          CEFR_BAND_ORDER[Math.max(0, CEFR_BAND_ORDER.indexOf(profile.userLevel) - 1)],
        ]
      : [profile.userLevel];
  return allowed.includes(level);
}

export interface RecommendationScore {
  articleId: string;
  score: number;
  /** 需要复习的单词�?*/
  dueWordsCount: number;
  /** L0-L2 的单词数（学习区�?*/
  learningZoneCount: number;
  /** L3-L4 的单词数（巩固区�?*/
  consolidationZoneCount: number;
  /** 未知单词数（无记忆状态） */
  unknownWordsCount: number;
  /** 平均记忆分数 */
  averageMemoryScore: number;
  /** 推荐原因 */
  reason: string;
  /** CEFR contribution, exposed for diagnostics and tie-break tests. */
  cefrScore?: number;
  cefrRelation?: CefrRelation;
  /** RME-V4 unique-word opportunity coverage contribution. */
  opportunityCoverage?: number;
}

export interface RecommendationParams {
  /** 用户当前 CEFR 等级 */
  userLevel?: string;
  /** 用户感兴趣的主题 */
  preferredTopics?: string[];
  /** 优先推荐包含到期单词的文�?*/
  prioritizeDueWords?: boolean;
  /** 学习区单词占比权�?*/
  learningZoneWeight?: number;
  /** 巩固区单词占比权�?*/
  consolidationZoneWeight?: number;
  /** 到期单词权重 */
  dueWordsWeight?: number;
  /** 最小学习区单词�?*/
  minLearningZoneWords?: number;
  /** 最大未知单词占�?*/
  maxUnknownWordsRatio?: number;
  /**
   * Minimum share of article lemmas present in the proficiency map before
   * personalized hard-filters apply. Below this coverage, candidates stay
   * available for cold-start ranking.
   */
  minProficiencyCoverage?: number;
  /** Base score used when ranking with little/no personalized evidence. */
  coldStartBaseScore?: number;
  /** Shared assessment-derived CEFR profile. */
  cefrProfile?: CefrRecommendationProfile;
  /** Explicit CEFR weight override for callers without a full profile. */
  cefrWeight?: number;
  /** Effective catalog bands after projecting the ideal user window. */
  allowedBands?: CefrBand[];
  /** Apply a reversible CEFR candidate window when assessment data exists. */
  cefrHardFilter?: boolean;
  /** Minimum eligible candidates required before the CEFR window is kept. */
  minCandidatesAfterCefrFilter?: number;
}

type ResolvedRecommendationParams = {
  userLevel: string;
  preferredTopics: string[];
  prioritizeDueWords: boolean;
  learningZoneWeight: number;
  consolidationZoneWeight: number;
  dueWordsWeight: number;
  minLearningZoneWords: number;
  maxUnknownWordsRatio: number;
  minProficiencyCoverage: number;
  coldStartBaseScore: number;
  cefrProfile?: CefrRecommendationProfile;
  cefrWeight?: number;
  allowedBands?: CefrBand[];
  cefrHardFilter?: boolean;
  minCandidatesAfterCefrFilter: number;
};

const DEFAULT_RECOMMENDATION_PARAMS: ResolvedRecommendationParams = {
  userLevel: 'B1',
  preferredTopics: [],
  prioritizeDueWords: true,
  learningZoneWeight: 3.0,
  consolidationZoneWeight: 2.0,
  dueWordsWeight: 5.0,
  minLearningZoneWords: 5,
  maxUnknownWordsRatio: 0.3,
  minProficiencyCoverage: 0.2,
  coldStartBaseScore: 10,
  minCandidatesAfterCefrFilter: 8,
};

/** True when the user has too little global evidence for hard personalization. */
export function isGlobalColdStart(
  proficiencyMap: Map<string, WordProficiencyView>,
  params: Pick<ResolvedRecommendationParams, 'minLearningZoneWords'> = DEFAULT_RECOMMENDATION_PARAMS
): boolean {
  return proficiencyMap.size < Math.max(1, params.minLearningZoneWords);
}

/** Fraction of article lemmas that already have a proficiency record. */
export function articleProficiencyCoverage(
  lemmas: readonly string[],
  proficiencyMap: Map<string, WordProficiencyView>
): number {
  if (lemmas.length === 0) return 0;
  let known = 0;
  for (const lemma of lemmas) {
    if (proficiencyMap.has(lemma)) known += 1;
  }
  return known / lemmas.length;
}

/**
 * Personalized unknown/learning-zone filters are only reliable when both the
 * global map and the article itself have enough tracked lemmas.
 */
export function shouldUsePersonalizedFilters(
  candidate: ArticleCandidate,
  proficiencyMap: Map<string, WordProficiencyView>,
  params: Pick<
    ResolvedRecommendationParams,
    'minLearningZoneWords' | 'minProficiencyCoverage'
  > = DEFAULT_RECOMMENDATION_PARAMS
): boolean {
  if (isGlobalColdStart(proficiencyMap, params)) return false;
  return (
    articleProficiencyCoverage(candidate.lemmas, proficiencyMap) >=
    params.minProficiencyCoverage
  );
}

/**
 * 文章推荐引擎
 */
export class RecommendationEngine {
  private params: ResolvedRecommendationParams;

  constructor(params: RecommendationParams = {}) {
    this.params = { ...DEFAULT_RECOMMENDATION_PARAMS, ...params };
  }

  getCefrProfile(): CefrRecommendationProfile {
    const profile = this.params.cefrProfile
      ?? buildCefrRecommendationProfile(
        null,
        resolveUserCefrLevel({ recommendedBand: this.params.userLevel })
      );
    return this.params.cefrWeight === undefined
      ? profile
      : { ...profile, cefrWeight: this.params.cefrWeight };
  }

  private articleLevel(candidate: ArticleCandidate): string {
    return normalizeCefrBand(
      candidate.article.levelRating?.level
      || candidate.article.level
      || candidate.article.rewriteTargetLevel
    );
  }

  private effectiveAllowedBands(candidates: readonly ArticleCandidate[]): CefrBand[] {
    if (this.params.allowedBands && this.params.allowedBands.length > 0) {
      return this.params.allowedBands;
    }
    const profile = this.getCefrProfile();
    return projectBandsOntoCatalog(
      profile.idealBands,
      candidates.map((candidate) => this.articleLevel(candidate))
    );
  }

  private cefrContribution(
    candidate: ArticleCandidate,
    allowedBands: readonly CefrBand[]
  ): { score: number; relation: CefrRelation } {
    const profile = this.getCefrProfile();
    const articleLevel = this.articleLevel(candidate);
    const relation = getCefrRelation(articleLevel, profile.userLevel);
    if (relation === 'unknown') return { score: 0, relation };
    if (
      !profile.hasAssessment
      && (relation === 'far-higher' || relation === 'far-lower')
    ) {
      return { score: 0, relation };
    }

    const isEffectivePreferred = allowedBands.includes(articleLevel as CefrBand);
    let base = 0;
    switch (relation) {
      case 'exact':
        base = 10;
        break;
      case 'adjacent-higher':
        base = 4;
        break;
      case 'adjacent-lower':
        base = 2;
        break;
      case 'far-higher':
        // A projected fallback (e.g. A2 → the catalog's B2 floor) is useful,
        // but should remain weaker than an actual exact/adjacent match.
        base = isEffectivePreferred ? 3 : -3;
        break;
      case 'far-lower':
        base = isEffectivePreferred ? 1 : -1;
        break;
    }

    return {
      score: base * profile.cefrWeight,
      relation,
    };
  }

  /**
   * 为候选文章打�?
   *
   * 评分逻辑�?
   * 1. 到期单词�?× dueWordsWeight
   * 2. 学习区单词数（L0-L2）�?learningZoneWeight
   * 3. 巩固区单词数（L3-L4）�?consolidationZoneWeight
   * 4. 主题匹配加成
   * 5. 等级匹配加成
   * 6. 惩罚未知单词过多的文�?
   */
  scoreArticle(
    candidate: ArticleCandidate,
    proficiencyMap: Map<string, WordProficiencyView>,
    now: Date = new Date()
  ): RecommendationScore {
    const { article, lemmas } = candidate;
    const params = this.params;
    const personalized = shouldUsePersonalizedFilters(candidate, proficiencyMap, params);
    const globallyColdStart = isGlobalColdStart(proficiencyMap, params);
    const allowedBands = this.effectiveAllowedBands([candidate]);

    let dueWordsCount = 0;
    let learningZoneCount = 0;
    let consolidationZoneCount = 0;
    let unknownWordsCount = 0;
    let totalMemoryScore = 0;
    let knownWordsCount = 0;

    // 统计各类单词
    for (const lemma of lemmas) {
      const proficiency = proficiencyMap.get(lemma);

      if (!proficiency) {
        // Untracked lemmas only count as hard "unknown" once personalization is reliable.
        if (personalized) unknownWordsCount++;
        continue;
      }

      knownWordsCount++;
      totalMemoryScore += proficiency.memoryScore;

      // 检查是否到�?
      if (new Date(proficiency.nextReview) <= now) {
        dueWordsCount++;
      }

      // 按等级分�?
      if (proficiency.level <= 2) {
        learningZoneCount++;
      } else {
        consolidationZoneCount++;
      }
    }

    const totalWords = lemmas.length || 1;
    const unknownWordsRatio = unknownWordsCount / totalWords;
    const averageMemoryScore = knownWordsCount > 0 ? totalMemoryScore / knownWordsCount : 0;

    // 计算基础分数
    // Low article coverage should remain eligible, but must not receive the
    // full cold-start bonus once the user has meaningful global evidence.
    let score = globallyColdStart ? params.coldStartBaseScore : 0;
    let reason = '';

    // 1. 到期单词得分
    if (dueWordsCount > 0) {
      score += dueWordsCount * params.dueWordsWeight;
      reason = `包含 ${dueWordsCount} 个到期单词`;
    }

    // 2. 学习区单词得�?
    if (learningZoneCount >= params.minLearningZoneWords) {
      score += learningZoneCount * params.learningZoneWeight;
      if (reason) reason += `，`;
      reason += `${learningZoneCount} 个学习区单词`;
    } else if (!personalized && learningZoneCount > 0) {
      score += learningZoneCount * params.learningZoneWeight * 0.5;
    }

    // 3. 巩固区单词得�?
    if (consolidationZoneCount > 0) {
      score += consolidationZoneCount * params.consolidationZoneWeight;
    }

    // 4. 主题匹配加成
    if (article.topic && params.preferredTopics.includes(article.topic)) {
      score *= 1.2;
      if (reason) reason += `，`;
      reason += `匹配偏好主题`;
    }

    // 5. CEFR is additive and applied after memory priority multipliers.
    const cefr = this.cefrContribution(candidate, allowedBands);
    if (cefr.score !== 0) {
      if (reason) reason += `，`;
      switch (cefr.relation) {
        case 'exact':
          reason += `匹配你的 ${this.getCefrProfile().userLevel}`;
          break;
        case 'adjacent-higher':
          reason += `略高于你的 ${this.getCefrProfile().userLevel}（冲刺）`;
          break;
        case 'adjacent-lower':
          reason += `略低于你的 ${this.getCefrProfile().userLevel}`;
          break;
        case 'far-higher':
          reason += `明显高于你的 ${this.getCefrProfile().userLevel}`;
          break;
        case 'far-lower':
          reason += `明显低于你的 ${this.getCefrProfile().userLevel}`;
          break;
      }
    }

    // 6. 惩罚未知单词过多（仅个性化阶段）
    if (personalized && unknownWordsRatio > params.maxUnknownWordsRatio) {
      const penalty = 1 - (unknownWordsRatio - params.maxUnknownWordsRatio);
      score *= Math.max(0.3, penalty);
      if (reason) reason += `，`;
      reason += `未知单词较多`;
    }

    // 7. 优先级调整：优先推荐有复习价值的文章
    if (params.prioritizeDueWords && dueWordsCount > 0) {
      score *= 1.5;
    }

    let wordCountScore = 0;
    const profile = this.getCefrProfile();
    if (
      profile.preferShorter
      && isGlobalColdStart(proficiencyMap, params)
      && getArticleWordCount(article) !== null
    ) {
      const range = suggestedWordCountRange(profile.userLevel);
      const wordCount = getArticleWordCount(article) ?? 0;
      if (wordCount <= range.max * 1.5) {
        wordCountScore = 1;
      } else if (wordCount > range.max * 3) {
        wordCountScore = -2;
      }
    }

    if (!reason) reason = personalized ? '接近当前水平' : '冷启动推荐';

    score += cefr.score + wordCountScore;

    return {
      articleId: article.id,
      score,
      dueWordsCount,
      learningZoneCount,
      consolidationZoneCount,
      unknownWordsCount: personalized
        ? unknownWordsCount
        : Math.max(0, lemmas.length - knownWordsCount),
      averageMemoryScore,
      reason,
      cefrScore: cefr.score,
      cefrRelation: cefr.relation,
    };
  }

  /**
   * 批量为候选文章打分并排序
   */
  rankArticles(
    candidates: ArticleCandidate[],
    proficiencyMap: Map<string, WordProficiencyView>,
    now: Date = new Date()
  ): RecommendationScore[] {
    const scores = candidates.map((candidate) =>
      this.scoreArticle(candidate, proficiencyMap, now)
    );

    // 按分数降序排�?
    scores.sort((a, b) => b.score - a.score);

    return scores;
  }

  /**
   * 推荐最佳文�?
   *
   * @param candidates - 候选文章列�?
   * @param proficiencyMap - 单词熟练度映�?
   * @param limit - 返回的推荐数�?
   * @returns 推荐文章及其评分
   */
  recommend(
    candidates: ArticleCandidate[],
    proficiencyMap: Map<string, WordProficiencyView>,
    limit: number = 5,
    now: Date = new Date()
  ): RecommendationScore[] {
    const ranked = this.rankArticles(candidates, proficiencyMap, now);
    return ranked.slice(0, limit);
  }

  /**
   * 过滤掉不适合的文�?
   *
   * 过滤条件�?
   * - 未知单词占比超过阈�?
   * - 学习区单词数不足
   * - 没有任何复习价值（全是 L4 或未知）
   */
  filterCandidates(
    candidates: ArticleCandidate[],
    proficiencyMap: Map<string, WordProficiencyView>,
    options: { protectedArticleIds?: ReadonlySet<string> } = {}
  ): ArticleCandidate[] {
    const params = this.params;
    const filtered = candidates.filter((candidate) => {
      if (candidate.lemmas.length === 0) return false;

      if (!isRecommendationArticleWithinBounds(
        candidate.article,
        this.getCefrProfile(),
        { checkCefr: false },
      )) {
        return false;
      }

      // Global cold start, or this article has too little tracked coverage:
      // keep the candidate so the library is never emptied for new/low-sample users.
      if (!shouldUsePersonalizedFilters(candidate, proficiencyMap, params)) {
        return true;
      }

      const score = this.scoreArticle(candidate, proficiencyMap);

      // 未知单词过多
      const totalWords = candidate.lemmas.length || 1;
      const unknownRatio = score.unknownWordsCount / totalWords;
      if (unknownRatio > params.maxUnknownWordsRatio) {
        return false;
      }

      // 学习区单词不足且没有到期单词
      if (
        score.learningZoneCount < params.minLearningZoneWords &&
        score.dueWordsCount === 0
      ) {
        return false;
      }

      return true;
    });

    const profile = this.getCefrProfile();
    const shouldUseCefrHardFilter = params.cefrHardFilter ?? profile.hasAssessment;
    if (!shouldUseCefrHardFilter || !profile.hasAssessment || filtered.length === 0) {
      return filtered;
    }

    const allowedBands = this.effectiveAllowedBands(filtered);
    if (allowedBands.length === 0) return filtered;

    const protectedArticleIds = options.protectedArticleIds ?? new Set<string>();
    const cefrFiltered = filtered.filter((candidate) => {
      if (protectedArticleIds.has(candidate.article.id)) return true;
      const level = this.articleLevel(candidate);
      return !level || allowedBands.includes(level as CefrBand);
    });
    const minimum = Math.min(
      Math.max(1, params.minCandidatesAfterCefrFilter),
      filtered.length
    );
    return cefrFiltered.length >= minimum ? cefrFiltered : filtered;
  }

  /**
   * 更新推荐参数
   */
  updateParams(params: Partial<RecommendationParams>): void {
    this.params = { ...this.params, ...params };
  }
}

/**
 * 多样性推荐：避免连续推荐相似主题的文�?
 */
export function diversifyRecommendations(
  recommendations: RecommendationScore[],
  articles: Map<string, Article>,
  recentArticleIds: string[],
  diversityWindow: number = 5
): RecommendationScore[] {
  const recentTopics = new Set<string>();

  // 收集最近阅读的文章主题
  for (const articleId of recentArticleIds.slice(-diversityWindow)) {
    const article = articles.get(articleId);
    if (article?.topic) {
      recentTopics.add(article.topic);
    }
  }

  // 降低相同主题文章的分�?
  const adjusted = recommendations.map((rec) => {
    const article = articles.get(rec.articleId);
    if (article?.topic && recentTopics.has(article.topic)) {
      return { ...rec, score: rec.score * 0.7 };
    }
    return rec;
  });

  // 重新排序
  adjusted.sort((a, b) => b.score - a.score);

  return adjusted;
}

/**
 * Count how many distinct review targets appear in article lemmas.
 * Repeated occurrences of the same lemma only count once.
 */
export function countUniqueReviewHits(
  lemmas: readonly string[],
  targetWords: ReadonlySet<string> | readonly string[]
): number {
  const targets = targetWords instanceof Set
    ? new Set(Array.from(targetWords).map(toLemma).filter(Boolean))
    : new Set(
        Array.from(targetWords)
          .map(toLemma)
          .filter(Boolean)
      );
  if (targets.size === 0) return 0;

  const present = new Set(lemmas.map(toLemma));
  let hits = 0;
  for (const word of targets) {
    if (present.has(word)) hits += 1;
  }
  return hits;
}

/**
 * Rank candidates by unique review-word coverage first.
 * Optional secondaryScores break ties (e.g. engine score).
 * Articles with zero hits are dropped.
 */
export function rankCandidatesByReviewHits(
  candidates: readonly ArticleCandidate[],
  targetWords: readonly string[] | ReadonlySet<string>,
  secondaryScores?: ReadonlyMap<string, number>
): ArticleCandidate[] {
  const targets = targetWords instanceof Set
    ? new Set(Array.from(targetWords).map(toLemma).filter(Boolean))
    : new Set(
        Array.from(targetWords)
          .map(toLemma)
          .filter(Boolean)
      );
  if (targets.size === 0) return [];

  return [...candidates]
    .map((candidate) => {
      const hits = countUniqueReviewHits(candidate.lemmas, targets);
      return {
        candidate,
        hits,
        ratio: hits / targets.size,
        secondary: secondaryScores?.get(candidate.article.id) ?? 0,
      };
    })
    .filter((row) => row.hits > 0)
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      if (b.ratio !== a.ratio) return b.ratio - a.ratio;
      return b.secondary - a.secondary;
    })
    .map((row) => row.candidate);
}

/**
 * 间隔重复推荐：确保到期单词得到及时复习�?
 * Primary key = unique target-word hits (not repeated lemma spam).
 */
export function scheduleReviewArticles(
  dueWords: WordProficiencyView[],
  candidates: ArticleCandidate[],
  targetReviewCount: number = 10
): ArticleCandidate[] {
  // 按到期紧急程度排�?
  const sortedDueWords = [...dueWords].sort((a, b) => {
    const aOverdue = new Date().getTime() - new Date(a.nextReview).getTime();
    const bOverdue = new Date().getTime() - new Date(b.nextReview).getTime();
    return bOverdue - aOverdue;
  });

  const priorityWords = sortedDueWords
    .slice(0, targetReviewCount)
    .map((w) => w.wordId);

  return rankCandidatesByReviewHits(candidates, priorityWords);
}

/** Large weight so unique review hits dominate generic learning-zone scores. */
export const REVIEW_HIT_SCORE_WEIGHT = 1000;

/**
 * Build recommendation scores optimized for review hit rate.
 * Sort key: unique hits × REVIEW_HIT_SCORE_WEIGHT + engine score.
 */
export function scoreArticlesForReview(
  candidates: readonly ArticleCandidate[],
  targetWords: readonly string[],
  proficiencyMap: Map<string, WordProficiencyView>,
  engine: RecommendationEngine,
  limit: number = 5,
  now: Date = new Date()
): RecommendationScore[] {
  const targets = [
    ...new Set(
      targetWords
        .map((word) => word.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  if (targets.length === 0 || candidates.length === 0) return [];

  const targetSet = new Set(targets);
  const scored: RecommendationScore[] = [];
  const profile = engine.getCefrProfile();
  const eligibleCandidates = candidates.filter((candidate) =>
    isRecommendationArticleWithinBounds(candidate.article, profile, {
      mode: 'review',
      checkCefr: true,
    })
  );

  for (const candidate of eligibleCandidates) {
    const hits = countUniqueReviewHits(candidate.lemmas, targetSet);
    if (hits <= 0) continue;

    const base = engine.scoreArticle(candidate, proficiencyMap, now);
    scored.push({
      ...base,
      score: hits * REVIEW_HIT_SCORE_WEIGHT + base.score,
      dueWordsCount: Math.max(base.dueWordsCount, hits),
      reason: `���� ${hits}/${targets.length} ����ϰ��${base.reason ? `��${base.reason}` : ''}`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}
