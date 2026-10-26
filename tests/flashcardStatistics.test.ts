import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFlashcardStatistics } from '../src/lib/flashcardStatistics';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

type Review = WordMemoryState['fsrsReviews'][number];
const now = new Date('2026-10-21T12:00:00.000Z');
const options = { now, timezone: 'UTC' };
function review(at: string, overrides: Partial<Review> = {}): Review {
  return { rating: 3, state: 2, due: at, stability: 5, difficulty: 5, elapsedDays: 2,
    lastElapsedDays: 2, scheduledDays: 2, learningSteps: 0, review: at, source: 'flashcard', ...overrides };
}
function word(wordId: string, reviews: Review[]): WordMemoryState {
  const state = initializeWordMemory('isolated-statistics-profile', wordId);
  return { ...state, lastReview: reviews.at(-1)?.review ?? null, fsrsReviews: reviews,
    fsrsCard: { ...state.fsrsCard, reps: reviews.length, state: 2 } };
}

test('no history is missing evidence, not a fabricated zero-percent recall rate', () => {
  const result = buildFlashcardStatistics([], options);
  assert.equal(result.delayedRecallCount, 0);
  assert.equal(result.recallRate, null);
  assert.equal(result.averageIntervalDays, null);
  assert.equal(result.comparison, 'insufficient');
  assert.equal(result.fromLocalDate, '2026-09-22');
  assert.equal(result.throughLocalDate, '2026-10-21');
  assert.match(result.comparisonNote, /样本较少（0\/30）/);
});

test('only delayed flashcard Review states contribute, with Hard/Good/Easy successful', () => {
  const rows = [
    word('new', [review('2026-10-01T12:00:00Z', { state: 0 })]),
    word('learning', [review('2026-10-01T12:00:00Z', { state: 1 })]),
    word('relearning', [review('2026-10-01T12:00:00Z', { state: 3 })]),
    word('lookup', [review('2026-10-01T12:00:00Z', { source: 'reading_lookup', rating: 1 })]),
    word('verification', [review('2026-10-01T12:00:00Z', { source: 'verification' })]),
    word('legacy', [review('2026-10-01T12:00:00Z', { source: undefined })]),
    ...[1, 2, 3, 4].map(rating => word(`rating-${rating}`, [review('2026-10-01T12:00:00Z', { rating })])),
  ];
  const result = buildFlashcardStatistics(rows, options);
  assert.equal(result.delayedRecallCount, 4);
  assert.equal(result.successfulRecallCount, 3);
  assert.equal(result.recallRate, 0.75);
  assert.equal(result.averageIntervalDays, 2);
});

test('first acquisition and same-session repetitions do not inflate delayed self-recall', () => {
  const result = buildFlashcardStatistics([word('memory', [
    review('2026-10-01T12:00:00Z', { state: 0, elapsedDays: 0 }),
    review('2026-10-01T12:10:00Z', { state: 1, elapsedDays: 0 }),
    review('2026-10-02T12:10:00Z', { rating: 1 }),
    review('2026-10-02T12:20:00Z', { state: 3, elapsedDays: 0 }),
    review('2026-10-02T12:30:00Z', { elapsedDays: 0 }),
  ])], options);
  assert.equal(result.delayedRecallCount, 1);
  assert.equal(result.successfulRecallCount, 0);
  assert.equal(result.recallRate, 0);
});

test('crossing midnight is not a delayed recall until 24 hours have elapsed', () => {
  const result = buildFlashcardStatistics([word('midnight', [
    review('2026-10-01T23:55:00Z', { state: 0, elapsedDays: 0 }),
    review('2026-10-02T00:05:00Z', { elapsedDays: 1 }),
  ])], options);
  assert.equal(result.delayedRecallCount, 0);
});

test('even a 25-hour DST day permits only its first flashcard attempt', () => {
  const result = buildFlashcardStatistics([word('fall-back', [
    review('2026-10-30T04:05:00Z', { state: 0, elapsedDays: 0 }),
    review('2026-11-01T04:05:00Z', { elapsedDays: 2 }), // 00:05 EDT
    review('2026-11-02T04:30:00Z', { elapsedDays: 1 }), // 23:30 EST, same local date
  ])], { now: new Date('2026-11-02T12:00:00Z'), timezone: 'America/New_York' });
  assert.equal(result.delayedRecallCount, 1);
  assert.equal(result.averageIntervalDays, 2);
});

test('the 30-calendar-day window follows explicit timezone, ignoring saved localDate', () => {
  const states = [word('window', [
    review('2026-09-20T12:00:00Z', { state: 0, elapsedDays: 0 }),
    review('2026-09-22T12:00:00Z', { localDate: '2026-09-23' }),
  ])];
  const at = new Date('2026-10-21T20:00:00Z');
  const utc = buildFlashcardStatistics(states, { now: at, timezone: 'UTC' });
  const shanghai = buildFlashcardStatistics(states, { now: at, timezone: 'Asia/Shanghai' });
  assert.equal(utc.delayedRecallCount, 1);
  assert.equal(shanghai.fromLocalDate, '2026-09-23');
  assert.equal(shanghai.delayedRecallCount, 0);
});

test('the corrected current rating replaces its original rating without extra attempts', () => {
  const states = [word('corrected', [review('2026-10-01T12:00:00Z', {
    rating: 3, originalFlashcardRating: 1,
    flashcardRevisions: [{ correctionId: 'correction-1', revision: 1, previousRating: 1, rating: 3,
      correctedAt: '2026-10-01T12:05:00Z' }],
  })])];
  const result = buildFlashcardStatistics(states, options);
  assert.equal(result.delayedRecallCount, 1);
  assert.equal(result.successfulRecallCount, 1);
});

test('repeated forgotten words require three delayed flashcard failures in this window', () => {
  const failures = [1, 3, 5].map(day => review(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`, { rating: 1 }));
  const result = buildFlashcardStatistics([
    word('repeated', failures),
    word('only-two', failures.slice(0, 2)),
    word('lookup-only', failures.map(row => ({ ...row, source: 'reading_lookup' }))),
    word('short-term', failures.map(row => ({ ...row, state: 3 }))),
    word('old', failures.map((row, index) => ({ ...row, review: `2026-09-${10 + index * 2}T12:00:00Z` }))),
  ], options);
  assert.deepEqual(result.repeatedForgottenWords, [{ wordId: 'repeated', failureCount: 3,
    recallCount: 3, lastFailureAt: '2026-10-05T12:00:00Z' }]);
});

test('sample threshold and target comparisons are descriptive and do not fit parameters', () => {
  const states = Array.from({ length: 30 }, (_, index) => word(`sample-${index}`, [
    review('2026-10-01T12:00:00Z', { rating: index < 27 ? 3 : 1 }),
  ]));
  assert.equal(buildFlashcardStatistics(states.slice(0, 29), options).comparison, 'insufficient');
  assert.equal(buildFlashcardStatistics(states, { ...options, desiredRetention: 0.9 }).comparison, 'near');
  assert.equal(buildFlashcardStatistics(states, { ...options, desiredRetention: 0.96 }).comparison, 'below');
  assert.equal(buildFlashcardStatistics(states, { ...options, desiredRetention: 0.8 }).comparison, 'above');
});

test('non-flashcard activity does not become a sample but prevents a false long-delay claim', () => {
  const result = buildFlashcardStatistics([word('recently-seen', [
    review('2026-10-01T12:00:00Z', { state: 0, elapsedDays: 0 }),
    review('2026-10-02T12:00:00Z', { source: 'verification' }),
    review('2026-10-02T12:05:00Z', { elapsedDays: 1 }),
  ])], options);
  assert.equal(result.delayedRecallCount, 0);
});

test('invalid and future logs never contribute and the input remains unchanged', () => {
  const states = [word('invalid', [
    review('2026-10-01T12:00:00Z', { elapsedDays: NaN }),
    review('2026-10-02T12:00:00Z', { rating: 9 }),
    review('2026-10-03T12:00:00Z', { elapsedDays: -1 }),
    review('invalid'), review('2026-10-22T12:00:00Z'),
  ])];
  const before = structuredClone(states);
  Object.freeze(states[0].fsrsReviews);
  Object.freeze(states[0]);
  Object.freeze(states);
  assert.equal(buildFlashcardStatistics(states, options).delayedRecallCount, 0);
  assert.deepEqual(states, before);
});

test('canonical aliases and repeated snapshots use a single memory owner', () => {
  const canonical = word('read', [review('2026-10-01T12:00:00Z', { rating: 1 })]);
  const alias = word('reading', [review('2026-10-02T12:00:00Z')]);
  const result = buildFlashcardStatistics([canonical, alias, canonical], {
    ...options, canonicalWordIds: new Map([['reading', 'read']]),
  });
  assert.equal(result.delayedRecallCount, 1);
  assert.equal(result.successfulRecallCount, 0);
});

test('invalid now, timezone and retention are rejected instead of showing misleading numbers', () => {
  assert.throws(() => buildFlashcardStatistics([], { ...options, now: new Date(NaN) }), TypeError);
  assert.throws(() => buildFlashcardStatistics([], { ...options, timezone: 'Invalid/Timezone' }), RangeError);
  for (const desiredRetention of [0, 1, -1, NaN, Infinity]) {
    assert.throws(() => buildFlashcardStatistics([], { ...options, desiredRetention }), RangeError);
  }
});
