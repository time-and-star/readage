import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeDailyEvidence, hasSufficientPassiveRecallEvidence, initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { applyRmeReview } from '../src/lib/memoryV2/rmeV4Bridge';
import { createEmptyRmeProfile, recordExposure } from '../src/lib/memoryV4';
import type { DailyWordEvidence } from '../src/lib/memoryV2/types';

function evidence(date: string, lastSeenAt: string, grade: 'Good' | 'Again' = 'Good'): DailyWordEvidence {
  return { userId: 'u', wordId: 'run', localDate: date,
    articleEvidence: [{ userId: 'u', wordId: 'run', articleId: 'a', localDate: date,
      validExposureCount: 1, clickedOccurrenceCount: grade === 'Again' ? 1 : 0,
      firstSeenAt: lastSeenAt, lastSeenAt, averageRmeQuality: 1 }],
    articleCount: 1, validExposureCount: 1, clickedOccurrenceCount: grade === 'Again' ? 1 : 0,
    pendingGrade: grade, finalizedAt: null, averageRmeQuality: 1 };
}

test('historical finalization cannot use passive evidence from a later day', () => {
  const state = initializeWordMemory('u', 'run');
  let profile = createEmptyRmeProfile();
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) {
    profile = recordExposure(profile, { articleId: 'a', occurrenceId: date, localDate: date,
      now: new Date(`${date}T09:00:00.000Z`), kind: date === '2026-09-01' ? 'new' : 'natural',
      isValid: date !== '2026-09-01', quality: 1 });
  }
  state.rme = profile;
  assert.equal(hasSufficientPassiveRecallEvidence(state), true);
  assert.equal(hasSufficientPassiveRecallEvidence(state, new Date('2026-09-02T23:59:59.999Z')), false);
  const secondDay = finalizeDailyEvidence(state, evidence('2026-09-02', '2026-09-02T09:00:00.000Z'), 'u', 'UTC')!;
  assert.equal(secondDay.fsrsReviews.length, 0);
  const thirdDay = finalizeDailyEvidence(secondDay, evidence('2026-09-03', '2026-09-03T09:00:00.000Z'), 'u', 'UTC')!;
  assert.equal(thirdDay.fsrsReviews.length, 0);
  assert.equal(thirdDay.lastReview, null);
});

test('new daily review timestamps reflect the latest actual evidence in the user day', () => {
  const day = evidence('2026-09-02', '2026-09-02T01:00:00.000Z', 'Again');
  day.articleEvidence.push({ ...day.articleEvidence[0], articleId: 'b',
    firstSeenAt: '2026-09-02T02:00:00.000Z', lastSeenAt: '2026-09-02T02:30:00.000Z' });
  const result = finalizeDailyEvidence(null, day, 'u', 'Asia/Shanghai')!;
  assert.equal(result.lastReview, '2026-09-02T02:30:00.000Z');
  assert.equal(result.fsrsReviews.at(-1)?.review, result.lastReview);
});

test('legacy, incomplete, or out-of-day timestamps keep the local day-end fallback', () => {
  const date = '2026-09-02';
  const incomplete = evidence(date, '2026-09-02T01:00:00.000Z', 'Again');
  incomplete.articleEvidence.push({ ...incomplete.articleEvidence[0], articleId: 'b', lastSeenAt: '' });
  const wrongDay = evidence(date, '2026-09-03T02:00:00.000Z', 'Again');
  const legacy = { ...incomplete, articleEvidence: [] };
  for (const day of [incomplete, wrongDay, legacy]) {
    assert.equal(finalizeDailyEvidence(null, day, 'u', 'Asia/Shanghai')?.lastReview, '2026-09-02T15:59:59.999Z');
  }
});

function reviewedState(ratings: Array<1 | 2 | 3 | 4>) {
  let state = initializeWordMemory('u', 'run');
  state.nextReview = '2026-09-01T09:00:00.000Z';
  state.fsrsCard.due = state.nextReview;
  state.rme = createEmptyRmeProfile();
  for (let index = 0; index < ratings.length; index += 1) {
    const at = new Date(`2026-09-0${index + 1}T09:00:00.000Z`);
    state = applyRmeReview(submitFsrsReview(state, ratings[index], at), ratings[index] === 1 ? 'Again' : 'Good', at);
  }
  return state;
}

function markWeakMeasuredOriginal(state: ReturnType<typeof reviewedState>, index: number) {
  const review = state.fsrsReviews[index];
  state.rme!.exposureHistory.push({ articleId: 'a', occurrenceId: `measured-${index}`,
    localDate: review.review.slice(0, 10), occurredAt: review.review,
    kind: 'natural', isValid: true, quality: 0.5, dwellTimeMs: 90_000, expectedDwellTimeMs: 30_000 });
}

test('reopened evidence and dwell snapshots cannot add a second review to a saved day', () => {
  const success = reviewedState([3]);
  const failure = reviewedState([1]);
  assert.strictEqual(finalizeDailyEvidence(success, evidence('2026-09-01', '2026-09-01T18:00:00.000Z'), 'u', 'UTC'), success);
  for (const grade of ['Good', 'Again'] as const) {
    assert.strictEqual(finalizeDailyEvidence(failure, evidence('2026-09-01', '2026-09-01T18:00:00.000Z', grade), 'u', 'UTC'), failure);
  }
});

test('a new lookup replaces saved success and replays later ratings without increasing repetitions', () => {
  const original = reviewedState([3, 3, 2, 4]);
  const expected = reviewedState([3]);
  let correct = applyRmeReview(submitFsrsReview(expected, 'Again', new Date('2026-09-02T18:00:00.000Z')),
    'Again', new Date('2026-09-02T18:00:00.000Z'));
  for (const review of original.fsrsReviews.slice(2)) {
    correct = submitFsrsReview(correct, review.rating as 1 | 2 | 3 | 4, new Date(review.review));
  }
  const updated = finalizeDailyEvidence(original, evidence('2026-09-02', '2026-09-02T18:00:00.000Z', 'Again'), 'u', 'UTC')!;
  assert.deepEqual(updated.fsrsCard, correct.fsrsCard);
  assert.deepEqual(updated.fsrsReviews, correct.fsrsReviews);
  assert.equal(updated.fsrsCard.reps, original.fsrsCard.reps);
  assert.deepEqual(updated.fsrsReviews[0], original.fsrsReviews[0]);
  assert.strictEqual(finalizeDailyEvidence(updated, evidence('2026-09-02', '2026-09-02T19:00:00.000Z', 'Again'), 'u', 'UTC'), updated);
});

test('replacing a historical Good removes its recovery credit while preserving exposure history', () => {
  const original = reviewedState([1, 1, 1, 3, 3]);
  assert.equal(original.rme?.forcedExposure, false);
  const updated = finalizeDailyEvidence(original, evidence('2026-09-04', '2026-09-04T18:00:00.000Z', 'Again'), 'u', 'UTC')!;
  assert.equal(updated.fsrsReviews.length, 5);
  assert.equal(updated.fsrsReviews[3].rating, 1);
  assert.equal(updated.rme?.forcedExposure, true);
  assert.equal(updated.rme?.recoveryStreak, 1);
  assert.deepEqual(updated.rme?.exposureHistory, original.rme?.exposureHistory);
});

test('a late weak measurement of the original encounter retracts premature Good and replays its tail', () => {
  const original = reviewedState([3, 3, 2, 4]);
  markWeakMeasuredOriginal(original, 1);
  const weak = evidence('2026-09-02', '2026-09-02T09:00:00.000Z');
  weak.pendingGrade = null;
  weak.averageRmeQuality = 0.5;
  weak.articleEvidence[0].averageRmeQuality = 0.5;
  let correct = reviewedState([3]);
  for (const review of original.fsrsReviews.slice(2)) {
    correct = submitFsrsReview(correct, review.rating as 1 | 2 | 3 | 4, new Date(review.review));
  }
  const updated = finalizeDailyEvidence(original, weak, 'u', 'UTC')!;
  assert.deepEqual(updated.fsrsCard, correct.fsrsCard);
  assert.deepEqual(updated.fsrsReviews, correct.fsrsReviews);
  assert.equal(updated.fsrsCard.reps, original.fsrsCard.reps - 1);
  assert.strictEqual(finalizeDailyEvidence(updated, weak, 'u', 'UTC'), updated);
});

test('weak measurements cannot revoke saved Again or a separate earlier encounter', () => {
  const weak = evidence('2026-09-01', '2026-09-01T09:00:00.000Z');
  weak.pendingGrade = null;
  weak.averageRmeQuality = 0.5;
  const failure = reviewedState([1]);
  assert.strictEqual(finalizeDailyEvidence(failure, weak, 'u', 'UTC'), failure);
  const success = reviewedState([3]);
  assert.strictEqual(finalizeDailyEvidence(success, weak, 'u', 'UTC'), success);
  markWeakMeasuredOriginal(success, 0);
  weak.articleEvidence[0].lastSeenAt = '2026-09-01T18:00:00.000Z';
  assert.strictEqual(finalizeDailyEvidence(success, weak, 'u', 'UTC'), success);
});

test('retracting the only premature Good restores the introduced state', () => {
  const original = reviewedState([3]);
  markWeakMeasuredOriginal(original, 0);
  const weak = evidence('2026-09-01', '2026-09-01T09:00:00.000Z');
  weak.pendingGrade = null;
  weak.averageRmeQuality = 0.5;
  const updated = finalizeDailyEvidence(original, weak, 'u', 'UTC')!;
  assert.equal(updated.fsrsCard.reps, 0);
  assert.equal(updated.fsrsReviews.length, 0);
  assert.equal(updated.lastReview, null);
  assert.equal(updated.stability, 0);
  assert.equal(updated.rme?.lastReviewGrade, null);
});
