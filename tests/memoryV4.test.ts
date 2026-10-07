import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyReviewOutcome,
  calculateConfidence,
  calculateExposureQuality,
  calculateOpportunityScore,
  classifyExposure,
  createEmptyRmeProfile,
  recordExposure,
  scoreArticleOpportunity,
  stageFromConfidence,
} from '../src/lib/memoryV4';
import { finalizeDailyEvidence, initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import type { DailyWordEvidence } from '../src/lib/memoryV2/types';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

test('requires 24 elapsed hours and a later local day for recall credit', () => {
  assert.deepEqual(
    classifyExposure({ now: NOW, isRecommendation: false, lastEffectiveExposureAt: null }),
    { kind: 'new', isValid: false },
  );
  assert.deepEqual(
    classifyExposure({
      now: NOW,
      isRecommendation: false,
      lastEffectiveExposureAt: new Date(NOW.getTime() - 23 * 60 * 60 * 1000).toISOString(),
    }),
    { kind: 'natural', isValid: false },
  );
  assert.deepEqual(
    classifyExposure({
      now: NOW,
      isRecommendation: true,
      hasFsrsReview: true,
      nextReview: new Date(NOW.getTime() - DAY).toISOString(),
      lastEffectiveExposureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    }),
    { kind: 'scheduled', isValid: true },
  );
  assert.deepEqual(
    classifyExposure({ now: NOW, isRecommendation: false, forcedExposure: true,
      lastEffectiveExposureAt: new Date(NOW.getTime() - DAY).toISOString() }),
    { kind: 'forced', isValid: true },
  );
});

test('allows the same article again on a later local day', () => {
  assert.deepEqual(
    classifyExposure({
      now: NOW,
      isRecommendation: true,
      hasFsrsReview: true,
      nextReview: new Date(NOW.getTime() - DAY).toISOString(),
      lastEffectiveExposureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      articleId: 'article-a',
      lastEffectiveArticleId: 'article-a',
    }),
    { kind: 'scheduled', isValid: true },
  );
  assert.deepEqual(
    classifyExposure({
      now: NOW,
      isRecommendation: true,
      hasFsrsReview: true,
      nextReview: new Date(NOW.getTime() - DAY).toISOString(),
      lastEffectiveExposureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      articleId: 'article-b',
      lastEffectiveArticleId: 'article-a',
    }),
    { kind: 'scheduled', isValid: true },
  );
});

test('maps exposure signals to bounded quality', () => {
  assert.equal(calculateExposureQuality({ clicked: true }), 0);
  assert.equal(calculateExposureQuality({ dwellTimeMs: 3_000, expectedDwellTimeMs: 1_000 }), 0.5);
  assert.equal(calculateExposureQuality({ dwellTimeMs: 1_200, expectedDwellTimeMs: 1_000 }), 1);
  assert.equal(calculateExposureQuality({ modelQuality: 4 }), 1);
  assert.equal(calculateExposureQuality({ modelQuality: -2 }), 0);
});

test('records first exposure without treating it as an effective review', () => {
  const profile = createEmptyRmeProfile();
  const updated = recordExposure(profile, {
    articleId: 'article-a',
    occurrenceId: 'article-a:p0:w1:abandon',
    now: NOW,
    kind: 'new',
    isValid: false,
    quality: 1,
  });

  assert.equal(updated.exposureHistory.length, 1);
  assert.equal(updated.lastEffectiveExposureAt, null);
  assert.equal(updated.successfulExposureCount, 0);
  assert.equal(updated.firstUnconfirmedExposureAt, NOW.toISOString());
});

test('does not move the first confirmation window after invalid natural retries', () => {
  const first = classifyExposure({
    now: NOW,
    isRecommendation: false,
    lastExposureAt: null,
    lastEffectiveExposureAt: null,
  });
  assert.deepEqual(first, { kind: 'new', isValid: false });

  const retryAt = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
  const retry = classifyExposure({
    now: retryAt,
    isRecommendation: false,
    userTimezone: 'UTC',
    articleId: 'article-b',
    lastEffectiveArticleId: 'article-a',
    lastExposureAt: NOW.toISOString(),
    firstUnconfirmedExposureAt: NOW.toISOString(),
    lastEffectiveExposureAt: null,
  });
  assert.deepEqual(retry, { kind: 'natural', isValid: false });

  const eligibleAt = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
  const eligible = classifyExposure({
    now: eligibleAt,
    isRecommendation: false,
    userTimezone: 'UTC',
    articleId: 'article-c',
    lastEffectiveArticleId: 'article-a',
    lastExposureAt: retryAt.toISOString(),
    firstUnconfirmedExposureAt: NOW.toISOString(),
    lastEffectiveExposureAt: null,
  });
  assert.deepEqual(eligible, { kind: 'natural', isValid: true });
});

test('deduplicates same-day rereads but counts the same occurrence again on a later day', () => {
  let profile = createEmptyRmeProfile();
  profile = recordExposure(profile, {
    articleId: 'article-a',
    occurrenceId: 'article-a:p0:w1',
    now: NOW,
    localDate: '2026-08-01',
    kind: 'natural',
    isValid: true,
    quality: 1,
  });

  const sameDay = recordExposure(profile, {
    articleId: 'article-a',
    occurrenceId: 'article-a:p0:w1',
    now: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    localDate: '2026-08-01',
    kind: 'natural',
    isValid: false,
    quality: 0,
  });
  assert.equal(sameDay.exposureHistory.length, 1);
  assert.equal(sameDay.successfulExposureCount, 1);

  profile = recordExposure(profile, {
    articleId: 'article-a',
    occurrenceId: 'article-a:p0:w1',
    now: new Date(NOW.getTime() + DAY),
    localDate: '2026-08-02',
    kind: 'natural',
    isValid: true,
    quality: 1,
  });
  assert.equal(profile.exposureHistory.length, 2);
  assert.equal(profile.successfulExposureCount, 2);
  assert.equal(profile.lastEffectiveLocalDate, '2026-08-02');
});

test('uses confirmation instead of scheduled classification before the first FSRS review', () => {
  assert.deepEqual(
    classifyExposure({
      now: NOW,
      isRecommendation: true,
      hasFsrsReview: false,
      nextReview: new Date(NOW.getTime() - DAY).toISOString(),
      lastExposureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      firstUnconfirmedExposureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      articleId: 'article-b',
      lastEffectiveArticleId: 'article-a',
    }),
    { kind: 'confirmation', isValid: true },
  );
});

test('enters forced exposure after three failures and recovers after two good days', () => {
  let profile = createEmptyRmeProfile();
  profile = applyReviewOutcome(profile, 'Again', NOW);
  profile = applyReviewOutcome(profile, 'Again', new Date(NOW.getTime() + DAY));
  profile = applyReviewOutcome(profile, 'Again', new Date(NOW.getTime() + 2 * DAY));
  assert.equal(profile.consecutiveAgain, 3);
  assert.equal(profile.forcedExposure, true);

  profile = applyReviewOutcome(profile, 'Good', new Date(NOW.getTime() + 3 * DAY));
  assert.equal(profile.forcedExposure, true);
  profile = applyReviewOutcome(profile, 'Good', new Date(NOW.getTime() + 4 * DAY));
  assert.equal(profile.forcedExposure, false);
  assert.equal(profile.recoveryStreak, 0);
});

test('does not recover forced exposure from a low-quality Good day', () => {
  let profile = createEmptyRmeProfile();
  profile = applyReviewOutcome(profile, 'Again', NOW);
  profile = applyReviewOutcome(profile, 'Again', new Date(NOW.getTime() + DAY));
  profile = applyReviewOutcome(profile, 'Again', new Date(NOW.getTime() + 2 * DAY));

  profile = applyReviewOutcome(profile, 'Good', new Date(NOW.getTime() + 3 * DAY), 0.5);
  assert.equal(profile.forcedExposure, true);
  assert.equal(profile.recoveryStreak, 0);

  profile = applyReviewOutcome(profile, 'Good', new Date(NOW.getTime() + 4 * DAY));
  profile = applyReviewOutcome(profile, 'Good', new Date(NOW.getTime() + 5 * DAY));
  assert.equal(profile.forcedExposure, false);
});

test('recall confidence follows FSRS independently of passive exposure quality', () => {
  let profile = createEmptyRmeProfile();
  profile = recordExposure(profile, {
    articleId: 'a', occurrenceId: 'o1', now: NOW, kind: 'natural', isValid: true, quality: 1,
  });
  profile = recordExposure(profile, {
    articleId: 'b', occurrenceId: 'o2', now: new Date(NOW.getTime() - DAY), kind: 'natural', isValid: true, quality: 0,
  });

  const confidence = calculateConfidence(profile, {
    stabilityDays: 10,
    lastReview: new Date(NOW.getTime() - DAY).toISOString(),
    hasRecallEvidence: true,
  }, NOW);
  assert.ok(confidence > 0 && confidence < 100);
  assert.equal(confidence, calculateConfidence(createEmptyRmeProfile(), {
    stabilityDays: 10,
    lastReview: new Date(NOW.getTime() - DAY).toISOString(),
    hasRecallEvidence: true,
  }, NOW));
  assert.equal(calculateConfidence(profile, {
    stabilityDays: 10,
    lastReview: new Date(NOW.getTime() - DAY).toISOString(),
    hasRecallEvidence: false,
  }, NOW), 0);
  assert.equal(stageFromConfidence(0), 0);
  assert.equal(stageFromConfidence(90), 4);
});

test('opportunity prioritizes forgetting risk and keeps forced words visible', () => {
  const profile = createEmptyRmeProfile();
  const normal = calculateOpportunityScore(profile, {
    now: NOW,
    forgettingRisk: 0.8,
    importance: 1,
    exposureGap: 1,
    stageWeight: 1,
    goalWeight: 1,
  });
  const forced = calculateOpportunityScore({ ...profile, forcedExposure: true }, {
    now: NOW,
    forgettingRisk: 0,
    importance: 0,
    exposureGap: 0,
    stageWeight: 0,
    goalWeight: 0,
  });
  assert.ok(normal > 0);
  assert.ok(forced >= 80);
});

test('article score sums unique opportunity coverage before secondary signals', () => {
  const high = scoreArticleOpportunity({
    lemmas: ['abandon', 'abandon', 'maintain'],
    opportunityByWord: new Map([['abandon', 90], ['maintain', 30]]),
    cefrScore: 8,
  });
  const low = scoreArticleOpportunity({
    lemmas: ['maintain'],
    opportunityByWord: new Map([['maintain', 30]]),
    cefrScore: 8,
  });
  assert.equal(high.opportunityCoverage, 120);
  assert.ok(high.articleScore > low.articleScore);
});

test('ordinary reading cannot clear a forced review state without verified success', () => {
  const evidence = (date: string, pendingGrade: 'Good' | 'Again'): DailyWordEvidence => ({
    userId: 'u1',
    wordId: 'abandon',
    localDate: date,
    articleEvidence: [],
    articleCount: 1,
    validExposureCount: 1,
    clickedOccurrenceCount: pendingGrade === 'Again' ? 1 : 0,
    pendingGrade,
    finalizedAt: null,
  });
  let state = initializeWordMemory('u1', 'abandon');

  state = finalizeDailyEvidence(state, evidence('2026-07-20', 'Again'), 'u1', 'UTC')!;
  state = finalizeDailyEvidence(state, evidence('2026-07-21', 'Again'), 'u1', 'UTC')!;
  state = finalizeDailyEvidence(state, evidence('2026-07-22', 'Again'), 'u1', 'UTC')!;
  assert.equal(state.rme?.forcedExposure, true);

  state = finalizeDailyEvidence(state, evidence('2026-07-23', 'Good'), 'u1', 'UTC')!;
  state = finalizeDailyEvidence(state, evidence('2026-07-24', 'Good'), 'u1', 'UTC')!;
  assert.equal(state.rme?.forcedExposure, true);
  assert.equal(state.fsrsReviews.length, 3);
});
