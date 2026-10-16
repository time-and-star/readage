import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyRmeProfile, recordExposure } from '../src/lib/memoryV4';
import { getUtcInstantForLocalDayEnd } from '../src/lib/memoryV2/dateUtils';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { repairPassiveReadingRecall } from '../src/lib/memoryV2/passiveRecallRepair';
import { applyRmeReview, hasFormalRecallEvidence } from '../src/lib/memoryV2/rmeV4Bridge';
import type { DailyWordEvidence, WordMemoryState } from '../src/lib/memoryV2/types';

type Review = WordMemoryState['fsrsReviews'][number];
const now = new Date('2026-10-09T12:00:00.000Z');
function empty(): WordMemoryState {
  const state = initializeWordMemory('u', 'run');
  state.nextReview = state.fsrsCard.due = '2026-08-01T12:00:00.000Z';
  return state;
}
function review(state: WordMemoryState, at: string, rating: 1 | 2 | 3 | 4,
  metadata: Partial<Review> = {}): WordMemoryState {
  const updated = submitFsrsReview(state, rating, new Date(at));
  updated.fsrsReviews[updated.fsrsReviews.length - 1] = { ...updated.fsrsReviews.at(-1)!, ...metadata };
  return updated;
}
function day(localDate: string, at = `${localDate}T12:00:00.000Z`): DailyWordEvidence {
  return { userId: 'u', wordId: 'run', localDate, pendingGrade: 'Good', clickedOccurrenceCount: 0,
    validExposureCount: 1, articleCount: 1, finalizedAt: `${localDate}T23:59:59.999Z`,
    articleEvidence: [{ userId: 'u', wordId: 'run', articleId: `article:${localDate}`, localDate,
      validExposureCount: 1, clickedOccurrenceCount: 0, firstSeenAt: at, lastSeenAt: at }] };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

test('keeps unproven legacy recalls, explicit recalls, and opaque imported history', () => {
  const legacy = review(empty(), '2026-09-01T12:00:00.000Z', 3);
  assert.strictEqual(repairPassiveReadingRecall(legacy, [], 'UTC', now), legacy);
  assert.strictEqual(repairPassiveReadingRecall(legacy, [day('2026-09-01', '2026-09-01T13:00:00.000Z')], 'UTC', now), legacy);
  const clicked = day('2026-09-01');
  clicked.clickedOccurrenceCount = 1;
  assert.strictEqual(repairPassiveReadingRecall(legacy, [clicked], 'UTC', now), legacy);
  const unrelated = { ...day('2026-09-01'), wordId: 'walk' };
  assert.strictEqual(repairPassiveReadingRecall(legacy, [unrelated], 'UTC', now), legacy);
  for (const source of ['flashcard', 'verification', 'reading_lookup'] as const) {
    const explicit = review(empty(), '2026-09-01T12:00:00.000Z', 3, { source });
    assert.strictEqual(repairPassiveReadingRecall(explicit, [day('2026-09-01')], 'UTC', now), explicit);
  }
  for (const metadata of [{ verificationAttemptIds: ['old:recall'] }, { originalFlashcardRating: 3 as const },
    { flashcardRevisions: [{ correctionId: 'old:fix', revision: 1, previousRating: 1 as const,
      rating: 3 as const, correctedAt: '2026-09-02T12:00:00.000Z' }] }]) {
    const identifiable = review(empty(), '2026-09-01T12:00:00.000Z', 3, metadata);
    assert.strictEqual(repairPassiveReadingRecall(identifiable, [day('2026-09-01')], 'UTC', now), identifiable);
  }
  const opaque = { ...legacy, fsrsReviews: [] };
  assert.strictEqual(repairPassiveReadingRecall(opaque, [day('2026-09-01')], 'UTC', now), opaque);
  assert.equal(hasFormalRecallEvidence(opaque), true);
});

test('rebuilds genuine recalls from the original empty baseline and retains lookup and correction audit', () => {
  const metadata: Partial<Review> = { source: 'flashcard', localDate: '2026-09-04',
    verificationAttemptIds: ['card:1'], originalFlashcardRating: 3,
    flashcardRevisions: [{ correctionId: 'fix:1', revision: 1, previousRating: 3, rating: 1,
      correctedAt: '2026-09-07T12:00:00.000Z' }] };
  let state = review(empty(), '2026-09-01T12:00:00.000Z', 3);
  state = review(state, '2026-09-02T12:00:00.000Z', 3);
  state = review(state, '2026-09-04T12:00:00.000Z', 1, metadata);
  state = review(state, '2026-09-05T12:00:00.000Z', 2, { source: 'verification', verificationAttemptIds: ['check:1'] });
  state = review(state, '2026-09-06T12:00:00.000Z', 1, { source: 'reading_lookup', localDate: '2026-09-06' });
  state.lastAssistedAt = '2026-09-06T11:59:00.000Z';
  state.rme = recordExposure(createEmptyRmeProfile(), { articleId: 'a', occurrenceId: 'occ:a',
    localDate: '2026-09-01', now: new Date('2026-09-01T12:00:00.000Z'), kind: 'natural',
    isValid: true, quality: 1, contextText: 'A runner runs.' });
  state.rme.consecutiveAgain = 7;
  state.rme.recoveryStreak = 1;
  const before = structuredClone(state);
  const days = freeze([day('2026-09-01'), day('2026-09-02')]);
  const repaired = repairPassiveReadingRecall(freeze(state), days, 'UTC', now);
  let expected = review(empty(), '2026-09-04T12:00:00.000Z', 1, metadata);
  expected = review(expected, '2026-09-05T12:00:00.000Z', 2, { source: 'verification', verificationAttemptIds: ['check:1'] });
  expected = review(expected, '2026-09-06T12:00:00.000Z', 1, { source: 'reading_lookup', localDate: '2026-09-06' });
  assert.deepEqual(repaired.fsrsCard, expected.fsrsCard);
  assert.deepEqual(repaired.fsrsReviews, expected.fsrsReviews);
  assert.equal(repaired.stability, expected.stability);
  assert.equal(repaired.nextReview, expected.nextReview);
  assert.equal(repaired.userId, before.userId);
  assert.equal(repaired.wordId, before.wordId);
  assert.equal(repaired.lastAssistedAt, before.lastAssistedAt);
  assert.deepEqual(repaired.rme!.exposureHistory, before.rme!.exposureHistory);
  assert.deepEqual(repaired.rme!.contextHistory, before.rme!.contextHistory);
  assert.equal(repaired.rme!.successfulExposureCount, before.rme!.successfulExposureCount);
  assert.equal(repaired.rme!.consecutiveAgain, 1);
  assert.equal(repaired.passiveReadingReviews!.length, 2);
  assert.deepEqual(repaired.passiveReadingReviews, before.fsrsReviews.slice(0, 2));
  assert.deepEqual(state, before);
  assert.strictEqual(repairPassiveReadingRecall(repaired, days, 'UTC', now), repaired);
});

test('preserves a reconstructable imported partial baseline while removing its passive tail', () => {
  const baseline = review(empty(), '2026-08-01T12:00:00.000Z', 4, { source: 'flashcard' });
  baseline.fsrsReviews = [];
  let state = review(baseline, '2026-09-01T12:00:00.000Z', 3);
  state = review(state, '2026-09-04T12:00:00.000Z', 3, { source: 'flashcard', verificationAttemptIds: ['card:2'] });
  const expected = review(baseline, '2026-09-04T12:00:00.000Z', 3, { source: 'flashcard', verificationAttemptIds: ['card:2'] });
  const repaired = repairPassiveReadingRecall(state, [day('2026-09-01')], 'UTC', now);
  assert.deepEqual(repaired.fsrsCard, expected.fsrsCard);
  assert.deepEqual(repaired.fsrsReviews, expected.fsrsReviews);
  assert.equal(repaired.fsrsCard.reps, 2);
  assert.equal(hasFormalRecallEvidence(repaired), true);
});

test('protects the unknown recovery outcome of an imported opaque prefix', () => {
  let baseline = { ...empty(), rme: createEmptyRmeProfile() };
  for (const date of ['2026-08-01', '2026-08-02', '2026-08-03']) {
    const at = new Date(`${date}T12:00:00.000Z`);
    baseline = applyRmeReview(review(baseline, at.toISOString(), 1, { source: 'flashcard' }), 'Again', at) as typeof baseline;
  }
  assert.equal(baseline.rme.forcedExposure, true);
  assert.equal(baseline.rme.consecutiveAgain, 3);
  baseline.fsrsReviews = [];
  const at = new Date('2026-09-01T12:00:00.000Z');
  const state = applyRmeReview(review(baseline, at.toISOString(), 3), 'Good', at);
  assert.equal(state.rme!.recoveryStreak, 1);
  const before = structuredClone(state);
  assert.strictEqual(repairPassiveReadingRecall(freeze(state), [day('2026-09-01')], 'UTC', now), state);
  assert.deepEqual(state, before);
  for (const profile of [{ forcedExposure: true }, { consecutiveAgain: 1 }, { recoveryStreak: 1 },
    { lastReviewGrade: 'Good' as const }, { lastReviewGrade: 'Again' as const }]) {
    const protectedState = { ...state, rme: { ...createEmptyRmeProfile(), ...profile } };
    assert.strictEqual(repairPassiveReadingRecall(protectedState, [day('2026-09-01')], 'UTC', now), protectedState);
  }
});

test('protects minute-based Learning and Relearning schedules absent from partial logs', () => {
  for (const stateCode of [1, 3]) {
    const baseline = review(empty(), '2026-08-01T12:00:00.000Z', 3, { source: 'flashcard' });
    baseline.fsrsReviews = [];
    baseline.fsrsCard.state = stateCode;
    baseline.fsrsCard.scheduledDays = 0;
    baseline.fsrsCard.due = baseline.nextReview = '2026-08-01T12:10:00.000Z';
    const state = review(baseline, '2026-09-01T12:00:00.000Z', 3);
    assert.equal(state.fsrsReviews[0].state, stateCode);
    const before = structuredClone(state);
    assert.strictEqual(repairPassiveReadingRecall(freeze(state), [day('2026-09-01')], 'UTC', now), state);
    assert.deepEqual(state, before);
  }
});

test('uses the requested local day end across DST and actual instants across zone changes', () => {
  const localDate = '2026-03-08';
  const at = getUtcInstantForLocalDayEnd(localDate, 'America/New_York');
  assert.equal(at.toISOString(), '2026-03-09T03:59:59.999Z');
  const state = review(empty(), at.toISOString(), 3);
  const repaired = repairPassiveReadingRecall(state, [day(localDate)], 'America/New_York', now);
  assert.equal(repaired.fsrsCard.reps, 0);
  assert.equal(repaired.lastReview, null);
  assert.equal(repaired.stability, 0);
  assert.equal(repaired.rme!.confidence, 0);
  assert.equal(hasFormalRecallEvidence(repaired), false);
  const actual = '2026-09-01T23:30:00.000Z';
  const captured = review(empty(), actual, 3, { localDate: '2026-09-02' });
  assert.equal(repairPassiveReadingRecall(captured, [day('2026-09-02', actual)], 'UTC', now).fsrsCard.reps, 0);
  const wrongDay = { ...captured, fsrsReviews: [{ ...captured.fsrsReviews[0], localDate: '2026-09-03' }] };
  assert.strictEqual(repairPassiveReadingRecall(wrongDay, [day('2026-09-02', actual)], 'UTC', now), wrongDay);
});

test('the persisted passive audit prevents old copies from resurrecting credit without daily evidence', () => {
  const state = review(empty(), '2026-09-01T12:00:00.000Z', 3);
  const repaired = repairPassiveReadingRecall(state, [day('2026-09-01')], 'UTC', now);
  const restored = { ...state, passiveReadingReviews: repaired.passiveReadingReviews };
  const again = repairPassiveReadingRecall(freeze(restored), [], 'UTC', now);
  assert.deepEqual(again, repaired);
  assert.strictEqual(repairPassiveReadingRecall(again, [], 'UTC', now), again);
  const formal = review(empty(), '2026-09-01T12:00:00.000Z', 3, { source: 'flashcard' });
  formal.passiveReadingReviews = repaired.passiveReadingReviews;
  assert.strictEqual(repairPassiveReadingRecall(formal, [], 'UTC', now), formal);
});

test('keeps unlabelled failures and rejects incomplete or future timelines', () => {
  const failure = review(empty(), '2026-09-01T12:00:00.000Z', 1);
  assert.strictEqual(repairPassiveReadingRecall(failure, [day('2026-09-01')], 'UTC', now), failure);
  const state = review(empty(), '2026-09-01T12:00:00.000Z', 3);
  const incomplete = { ...state, fsrsCard: { ...state.fsrsCard, reps: 0 } };
  assert.strictEqual(repairPassiveReadingRecall(incomplete, [day('2026-09-01')], 'UTC', now), incomplete);
  assert.strictEqual(repairPassiveReadingRecall(state, [day('2026-09-01')], 'UTC', new Date('2026-08-01')), state);
});
