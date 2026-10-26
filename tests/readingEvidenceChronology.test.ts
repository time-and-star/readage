import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { replayVerificationEvidence } from '../src/lib/memoryV2/verificationMemory';
import type { DailyWordEvidence, ReadingVerificationEvidence } from '../src/lib/memoryV2/types';

const policy = createFlashcardSchedulingPolicy(0.9);
const morning = '2026-10-23T08:00:00.000Z';
const noon = '2026-10-23T12:00:00.000Z';
const evening = '2026-10-23T20:00:00.000Z';
const now = new Date('2026-10-24T08:00:00.000Z');
function reading(attemptId: string, outcome: 'recognized' | 'incorrect' | 'uncertain', occurredAt: string,
  scheduling = policy): ReadingVerificationEvidence {
  return { attemptId, questionId: attemptId, wordId: 'recall', articleId: attemptId,
    outcome, occurredAt, userId: 'isolated-reading-chronology', localDate: '2026-10-23',
    timezone: 'UTC', purpose: 'delayed_verification', scheduling };
}
function card(occurredAt: string): ReadingVerificationEvidence {
  return { ...reading('word-card', 'recognized', occurredAt), purpose: 'flashcard_review', rating: 3 };
}
const summarize = (state: NonNullable<ReturnType<typeof replayVerificationEvidence>>) =>
  state.fsrsReviews.map(review => [review.review, review.rating, review.source]);

test('a later reading success cannot move a morning failure past an intervening word-card recall', () => {
  const failed = reading('morning-failure', 'incorrect', morning);
  const recalled = card(noon);
  const before = replayVerificationEvidence(null, [failed, recalled], 'UTC', [], now)!;
  const recognized = reading('evening-recognition', 'recognized', evening, createFlashcardSchedulingPolicy(0.95));
  const attempts = [failed, recalled, recognized];
  const originalAttempts = structuredClone(attempts);
  const after = replayVerificationEvidence(before, attempts, 'UTC', [], now)!;
  assert.deepEqual(summarize(after), [[morning, 1, 'verification'], [noon, 3, 'flashcard']]);
  assert.deepEqual(after.fsrsCard, before.fsrsCard);
  assert.deepEqual(after.fsrsReviews, before.fsrsReviews);
  assert.deepEqual(after.fsrsReviews[0].scheduling, failed.scheduling);
  assert.deepEqual(attempts, originalAttempts, 'raw attempts retain their actual times and outcomes');
  assert.deepEqual(replayVerificationEvidence(after, attempts, 'UTC', [], now), after, 'replay is idempotent');
});

test('the daily failure representative uses the last actual failure and its frozen policy', () => {
  const laterFailure = reading('later-failure', 'uncertain', noon, createFlashcardSchedulingPolicy(0.93));
  const saved = replayVerificationEvidence(null, [reading('first-failure', 'incorrect', morning), laterFailure,
    reading('late-success', 'recognized', evening, createFlashcardSchedulingPolicy(0.97))], 'UTC', [], now)!;
  assert.deepEqual(summarize(saved), [[noon, 1, 'verification']]);
  assert.deepEqual(saved.fsrsReviews[0].scheduling, laterFailure.scheduling);
  assert.deepEqual(saved.fsrsReviews[0].verificationAttemptIds, ['first-failure', 'later-failure']);
});

for (const frozen of [undefined, createFlashcardSchedulingPolicy(0.85)]) {
  test(`revising an independent daily success keeps its ${frozen ? 'frozen' : 'legacy'} policy and the real failure time`, () => {
    const before = submitFsrsReview(initializeWordMemory('isolated-reading-chronology', 'recall'),
      3, new Date(evening), frozen);
    Object.assign(before.fsrsReviews[0], { source: 'verification', localDate: '2026-10-23',
      verificationAttemptIds: ['independent-imported-success'] });
    const saved = replayVerificationEvidence(before, [reading('late-arriving-failure', 'incorrect', morning)], 'UTC', [], now)!;
    assert.deepEqual(summarize(saved), [[morning, 1, 'verification']]);
    assert.deepEqual(saved.fsrsReviews[0].scheduling, frozen);
  });
}

test('a same-millisecond success does not move a representative failure after the word card between them', () => {
  const failed = reading('failure-first', 'incorrect', noon);
  const recalled = card(noon);
  const before = replayVerificationEvidence(null, [failed, recalled], 'UTC', [], now)!;
  const attempts = [failed, recalled, reading('recognition-last', 'recognized', noon)];
  const saved = replayVerificationEvidence(before, attempts, 'UTC', [], now)!;
  assert.deepEqual(summarize(saved), [[noon, 1, 'verification'], [noon, 3, 'flashcard']]);
  assert.deepEqual(saved.fsrsCard, before.fsrsCard);
  assert.deepEqual(replayVerificationEvidence(saved, attempts, 'UTC', [], now), saved);
});

test('a lookup failure keeps its actual time when merged with a later successful reading answer', () => {
  const lookup: DailyWordEvidence = { userId: 'isolated-reading-chronology', wordId: 'recall',
    localDate: '2026-10-23', articleCount: 1, validExposureCount: 1, clickedOccurrenceCount: 1,
    recallFailureCount: 1, pendingGrade: 'Again', finalizedAt: null,
    articleEvidence: [{ userId: 'isolated-reading-chronology', wordId: 'recall', articleId: 'legacy-lookup',
      localDate: '2026-10-23', validExposureCount: 1, clickedOccurrenceCount: 1, recallFailureCount: 1,
      firstSeenAt: morning, lastSeenAt: evening, lastRecallFailureAt: morning }] };
  const saved = replayVerificationEvidence(null, [card(noon), reading('recognized', 'recognized', evening)],
    'UTC', [lookup], now)!;
  assert.deepEqual(summarize(saved), [[morning, 1, 'reading_lookup'], [noon, 3, 'flashcard']]);
});
