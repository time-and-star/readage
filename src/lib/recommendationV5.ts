import {
  getCefrRelation,
  type CefrRelation,
} from './userReadingProfile';

export type V5RecommendationGoal =
  | 'general'
  | 'ielts'
  | 'gre'
  | 'academic'
  | 'fluency'
  | (string & {});

export interface V5ScoreWeights {
  opportunity: number;
  interest: number;
  difficulty: number;
  goal: number;
  novelty: number;
  length: number;
}

export const DEFAULT_V5_SCORE_WEIGHTS: V5ScoreWeights = {
  opportunity: 0.50,
  interest: 0.18,
  difficulty: 0.12,
  goal: 0.10,
  novelty: 0.05,
  length: 0.05,
};

export interface V5RecommendationProfile {
  userLevel?: string;
  goal?: V5RecommendationGoal;
  preferredTopics?: readonly string[];
  recentTopics?: readonly string[];
  targetWordCount?: { min: number; max: number };
  weights?: Partial<V5ScoreWeights>;
}

export interface DefaultV5ProfileInput {
  userLevel?: string;
  goal?: V5RecommendationGoal;
  topic?: string;
  recentTopics?: readonly (string | null | undefined)[];
  targetWordCount?: { min: number; max: number };
}

export interface V5ArticleCandidate {
  articleId: string;
  opportunityCoverage: number;
  topic?: string;
  level?: string;
  estimatedWordCount?: number;
  goalTags?: readonly string[];
}

export interface V5FeatureBreakdown {
  opportunity: number;
  interest: number;
  difficulty: number;
  goal: number;
  novelty: number;
  length: number;
  cefrRelation: CefrRelation;
}

export interface V5ArticleScore {
  articleId: string;
  score: number;
  features: V5FeatureBreakdown;
  reason: string;
}

export interface V5RecommendationRow {
  articleId: string;
  score: number;
  opportunityCoverage?: number;
  dueWordsCount?: number;
  reason?: string;
}

const GOAL_TOPIC_HINTS: Record<string, readonly string[]> = {
  ielts: ['education', 'environment', 'society', 'culture', 'health', 'technology', 'work'],
  gre: ['academic', 'science', 'technology', 'business', 'history', 'society'],
  academic: ['academic', 'science', 'technology', 'research', 'business'],
  fluency: ['culture', 'travel', 'life', 'health', 'technology', 'society'],
};

/** Derive the V5 context from existing recommendation metadata only. */
export function buildDefaultV5Profile(
  input: DefaultV5ProfileInput = {},
): V5RecommendationProfile {
  const topic = input.topic?.trim();
  const recentTopics = [...new Set(
    (input.recentTopics || [])
      .map((item) => item?.trim())
      .filter((item): item is string => Boolean(item)),
  )];
  const profile: V5RecommendationProfile = {
    goal: input.goal?.trim() || 'general',
    preferredTopics: topic ? [topic] : [],
    recentTopics,
  };
  if (input.userLevel?.trim()) profile.userLevel = input.userLevel.trim();
  if (input.targetWordCount) profile.targetWordCount = input.targetWordCount;
  return profile;
}

const clamp01 = (value: number): number =>
  Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** A few high-priority words must not saturate a sum of per-word opportunities. */
function opportunityFit(coverage: number): number {
  const safeCoverage = Number.isFinite(coverage) ? Math.max(0, coverage) : 0;
  return safeCoverage / (safeCoverage + 400);
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() || '';
}

function topicMatches(topic: string | undefined, topics: readonly string[] | undefined): boolean {
  const candidate = normalized(topic);
  if (!candidate || !topics || topics.length === 0) return false;
  return topics.some((item) => normalized(item) === candidate);
}

function resolveWeights(profile: V5RecommendationProfile): V5ScoreWeights {
  const merged = { ...DEFAULT_V5_SCORE_WEIGHTS, ...profile.weights };
  const safeWeight = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, value) : 0;
  const total = Object.values(merged).reduce((sum, value) => sum + safeWeight(value), 0);
  if (total <= 0) return DEFAULT_V5_SCORE_WEIGHTS;
  return {
    opportunity: safeWeight(merged.opportunity) / total,
    interest: safeWeight(merged.interest) / total,
    difficulty: safeWeight(merged.difficulty) / total,
    goal: safeWeight(merged.goal) / total,
    novelty: safeWeight(merged.novelty) / total,
    length: safeWeight(merged.length) / total,
  };
}

function difficultyFit(articleLevel: string | undefined, userLevel: string | undefined): {
  score: number;
  relation: CefrRelation;
} {
  if (!userLevel) return { score: 0.5, relation: 'unknown' };
  const relation = getCefrRelation(articleLevel, userLevel);
  switch (relation) {
    case 'exact': return { score: 1, relation };
    case 'adjacent-lower':
    case 'adjacent-higher': return { score: 0.8, relation };
    case 'far-lower':
    case 'far-higher': return { score: 0.3, relation };
    default: return { score: 0.5, relation };
  }
}

function lengthFit(
  wordCount: number | undefined,
  target: V5RecommendationProfile['targetWordCount'],
): number {
  if (
    !target
    || !Number.isFinite(wordCount)
    || !Number.isFinite(target.min)
    || !Number.isFinite(target.max)
    || target.max < target.min
  ) return 0.5;
  const count = Number(wordCount);
  if (count >= target.min && count <= target.max) return 1;
  const span = Math.max(1, target.max - target.min);
  const distance = count < target.min ? target.min - count : count - target.max;
  return clamp01(1 - distance / (span * 2));
}

function goalFit(candidate: V5ArticleCandidate, goal: V5RecommendationGoal | undefined): number {
  if (!goal || normalized(goal) === 'general') return 0.6;
  const normalizedGoal = normalized(goal);
  const tags = (candidate.goalTags || []).map(normalized).filter(Boolean);
  if (tags.includes(normalizedGoal)) return 1;
  const hints = GOAL_TOPIC_HINTS[normalizedGoal] || [];
  if (candidate.topic && hints.includes(normalized(candidate.topic))) return 0.8;
  return 0.4;
}

export function scoreArticleV5(
  candidate: V5ArticleCandidate,
  profile: V5RecommendationProfile = {},
): V5ArticleScore {
  const weights = resolveWeights(profile);
  const difficulty = difficultyFit(candidate.level, profile.userLevel);
  const features: V5FeatureBreakdown = {
    opportunity: opportunityFit(candidate.opportunityCoverage),
    interest: profile.preferredTopics?.length
      ? topicMatches(candidate.topic, profile.preferredTopics) ? 1 : 0.45
      : 0.5,
    difficulty: difficulty.score,
    goal: goalFit(candidate, profile.goal),
    novelty: topicMatches(candidate.topic, profile.recentTopics) ? 0.25 : 1,
    length: lengthFit(candidate.estimatedWordCount, profile.targetWordCount),
    cefrRelation: difficulty.relation,
  };
  const score = Object.entries(weights).reduce((sum, [key, weight]) => {
    const feature = features[key as keyof Omit<V5FeatureBreakdown, 'cefrRelation'>];
    return sum + feature * weight;
  }, 0) * 100;

  const reasonParts: string[] = [];
  if (features.opportunity >= 0.6) reasonParts.push('高机会词覆盖');
  if (features.interest >= 0.9) reasonParts.push('匹配兴趣主题');
  if (features.goal >= 0.9) reasonParts.push('符合学习目标');
  if (difficulty.relation === 'exact') reasonParts.push('难度匹配');
  if (features.novelty < 0.5) reasonParts.push('近期主题重复');

  return {
    articleId: candidate.articleId,
    score,
    features,
    reason: reasonParts.join('，') || '综合阅读价值',
  };
}

export function rankArticlesV5(
  candidates: readonly V5ArticleCandidate[],
  profile: V5RecommendationProfile = {},
): V5ArticleScore[] {
  return candidates
    .map((candidate) => scoreArticleV5(candidate, profile))
    .sort((left, right) => right.score - left.score);
}

/** Apply V5 ranking to an existing recommendation result without changing its shape. */
export function rerankRecommendationScoresV5<T extends V5RecommendationRow>(
  recommendations: readonly T[],
  candidates: readonly V5ArticleCandidate[],
  profile: V5RecommendationProfile = {},
): T[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.articleId, candidate]));
  return recommendations
    .map((recommendation) => {
      const candidate = candidateById.get(recommendation.articleId);
      if (!candidate) return recommendation;
      const scored = scoreArticleV5({
        ...candidate,
        opportunityCoverage: recommendation.opportunityCoverage
          ?? candidate.opportunityCoverage
          ?? (recommendation.dueWordsCount ?? 0) * 40,
      }, profile);
      const reason = recommendation.reason && recommendation.reason !== scored.reason
        ? `${scored.reason}；${recommendation.reason}`
        : scored.reason;
      return { ...recommendation, score: scored.score, reason };
    })
    .sort((left, right) => right.score - left.score);
}
