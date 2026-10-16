import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDefaultV5Profile,
  rankArticlesV5,
  rerankRecommendationScoresV5,
  scoreArticleV5,
  type V5ArticleCandidate,
  type V5RecommendationProfile,
} from '../src/lib/recommendationV5';

const profile: V5RecommendationProfile = {
  userLevel: 'B1',
  goal: 'ielts',
  preferredTopics: ['environment'],
  recentTopics: ['technology'],
  targetWordCount: { min: 180, max: 320 },
};

function candidate(overrides: Partial<V5ArticleCandidate> = {}): V5ArticleCandidate {
  return {
    articleId: 'article',
    opportunityCoverage: 0,
    topic: 'culture',
    level: 'B1',
    estimatedWordCount: 220,
    goalTags: [],
    ...overrides,
  };
}

test('V5 gives a high-opportunity article a strong memory signal', () => {
  const score = scoreArticleV5(candidate({ opportunityCoverage: 160 }), profile);
  const low = scoreArticleV5(candidate({ articleId: 'low', opportunityCoverage: 0 }), profile);

  assert.ok(score.features.opportunity > low.features.opportunity);
  assert.ok(score.score > low.score);
});

test('V5 continues rewarding broader coverage after the first few opportunity words', () => {
  const few = scoreArticleV5(candidate({ opportunityCoverage: 160 }), profile);
  const many = scoreArticleV5(candidate({ opportunityCoverage: 960 }), profile);
  const more = scoreArticleV5(candidate({ opportunityCoverage: 1600 }), profile);

  assert.ok(many.features.opportunity > few.features.opportunity);
  assert.ok(many.score > few.score);
  assert.ok(more.score > many.score);
  assert.ok(more.features.opportunity < 1);
});

test('V5 profile can be derived from existing reading context without raw article text', () => {
  const derived = buildDefaultV5Profile({
    userLevel: 'B2',
    topic: 'science',
    recentTopics: ['culture', 'technology'],
    targetWordCount: { min: 250, max: 400 },
  });

  assert.deepEqual(derived, {
    userLevel: 'B2',
    goal: 'general',
    preferredTopics: ['science'],
    recentTopics: ['culture', 'technology'],
    targetWordCount: { min: 250, max: 400 },
  });
});

test('V5 combines topic interest and goal tags with memory opportunity', () => {
  const preferred = candidate({
    articleId: 'preferred',
    topic: 'environment',
    goalTags: ['ielts'],
    opportunityCoverage: 20,
  });
  const memoryOnly = candidate({
    articleId: 'memory-only',
    topic: 'finance',
    opportunityCoverage: 90,
  });

  const ranked = rankArticlesV5([memoryOnly, preferred], profile);
  assert.equal(ranked[0]?.articleId, 'preferred');
  assert.equal(ranked[0]?.features.interest, 1);
  assert.equal(ranked[0]?.features.goal, 1);
});

test('V5 penalizes articles far outside level, length, and recent-topic preferences', () => {
  const suitable = scoreArticleV5(candidate({
    articleId: 'suitable',
    topic: 'environment',
    level: 'B2',
    estimatedWordCount: 260,
    goalTags: ['ielts'],
  }), profile);
  const unsuitable = scoreArticleV5(candidate({
    articleId: 'unsuitable',
    topic: 'technology',
    level: 'C2',
    estimatedWordCount: 900,
    goalTags: ['gre'],
  }), profile);

  assert.ok(suitable.features.difficulty > unsuitable.features.difficulty);
  assert.ok(suitable.features.length > unsuitable.features.length);
  assert.ok(suitable.features.novelty > unsuitable.features.novelty);
  assert.ok(suitable.score > unsuitable.score);
});

test('V5 can rerank existing recommendation rows without changing their identity', () => {
  const rows = rerankRecommendationScoresV5([
    { articleId: 'memory', score: 40, opportunityCoverage: 80, reason: 'V4' },
    { articleId: 'interest', score: 30, opportunityCoverage: 10, reason: 'V4' },
  ], [
    candidate({ articleId: 'memory', topic: 'finance' }),
    candidate({ articleId: 'interest', topic: 'environment' }),
  ], profile);

  assert.equal(rows[0]?.articleId, 'interest');
  assert.equal(rows[0]?.reason?.includes('V4'), true);
});

test('V5 keeps malformed custom weights from producing a non-finite score', () => {
  const scored = scoreArticleV5(candidate({ opportunityCoverage: 50 }), {
    weights: {
      opportunity: Number.NaN,
      interest: Number.POSITIVE_INFINITY,
    },
  });

  assert.equal(Number.isFinite(scored.score), true);
});
