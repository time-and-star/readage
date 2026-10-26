import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreMemoryBeforeReview } from '../src/lib/memoryV2/reviewSnapshot';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { replayWordJournal, type WordJournal } from '../src/lib/browserExtension/replay';
import { repairPassiveReadingRecall } from '../src/lib/memoryV2/passiveRecallRepair';
import type { DailyWordEvidence, WordMemoryState } from '../src/lib/memoryV2/types';

const at = new Date('2026-10-01T12:00:00.000Z');
const balanced = { version: 1 as const, desiredRetention: 0.93 };
const intensive = { version: 1 as const, desiredRetention: 0.95 };
function empty(): WordMemoryState {
  const state = initializeWordMemory('snapshot-user', 'remember');
  state.nextReview = state.fsrsCard.due = at.toISOString();
  return state;
}
function flashcard(state: WordMemoryState, rating: 1 | 2 | 3 | 4, when: Date,
  policy = balanced): WordMemoryState {
  const updated = submitFsrsReview(state, rating, when, policy);
  updated.fsrsReviews.at(-1)!.source = 'flashcard';
  updated.fsrsReviews.at(-1)!.verificationAttemptIds = [`recall-${updated.fsrsCard.reps}`];
  return updated;
}

test('review snapshots restore minute due times, steps and counters without mutating the saved history', () => {
  const learning = flashcard(empty(), 3, at);
  assert.equal(learning.fsrsCard.state, 1);
  assert.equal(Date.parse(learning.nextReview) - at.getTime(), 10 * 60_000);
  const later = flashcard(learning, 3, new Date(learning.nextReview));
  const before = structuredClone(later);
  const restored = restoreMemoryBeforeReview(later, 1);
  assert.deepEqual(restored.fsrsCard, learning.fsrsCard);
  assert.equal(restored.lastReview, learning.lastReview);
  assert.equal(restored.nextReview, learning.nextReview);
  assert.deepEqual(restored.fsrsReviews, learning.fsrsReviews);
  restored.fsrsCard.due = at.toISOString();
  assert.deepEqual(later, before);
  assert.throws(() => restoreMemoryBeforeReview(later, -1), /unknown FSRS review/);
  assert.throws(() => restoreMemoryBeforeReview(later, later.fsrsReviews.length), /unknown FSRS review/);
});

test('legacy logs retain their original whole-day schedule and unlogged baseline', () => {
  const baseline = submitFsrsReview(empty(), 3, at);
  baseline.fsrsReviews = [];
  const reviewed = submitFsrsReview(baseline, 1, new Date(baseline.nextReview));
  delete reviewed.fsrsReviews[0].beforeCard;
  const restored = restoreMemoryBeforeReview(reviewed, 0);
  assert.deepEqual(restored.fsrsCard, baseline.fsrsCard);
  assert.equal(restored.fsrsCard.reps, 1);
  assert.equal(restored.fsrsCard.lapses, 0);
  assert.deepEqual(restored.fsrsReviews, []);
});

test('legacy fallback counts a failed mature recall once and never counts repeated short-term failures as lapses', () => {
  let state = flashcard(empty(), 4, at);
  state = flashcard(state, 1, new Date(state.nextReview));
  const relearning = state;
  state = flashcard(state, 1, new Date(state.nextReview));
  state = flashcard(state, 1, new Date(state.nextReview));
  assert.equal(state.fsrsCard.lapses, 1);
  state.fsrsReviews.forEach(review => { delete review.beforeCard; });
  assert.equal(restoreMemoryBeforeReview(state, 1).fsrsCard.lapses, 0);
  const beforeRelearningFailure = restoreMemoryBeforeReview(state, 2);
  assert.equal(beforeRelearningFailure.fsrsCard.lapses, 1);
  assert.equal(beforeRelearningFailure.fsrsCard.state, 3);
  assert.equal(beforeRelearningFailure.lastReview, relearning.lastReview);
});

test('extension replay preserves mixed retention policies and reconstructs short-term snapshots', () => {
  let state = flashcard(empty(), 3, at);
  state = flashcard(state, 3, new Date(state.nextReview));
  state = flashcard(state, 1, new Date(state.nextReview), intensive);
  state = flashcard(state, 1, new Date(state.nextReview), intensive);
  state = flashcard(state, 3, new Date(state.nextReview), intensive);
  const journal: WordJournal = { version: 1, userId: state.userId, wordId: state.wordId,
    baselineState: state, baselineDaily: [], baselineRaw: [], events: [] };
  const original = structuredClone(journal);
  const now = new Date('2026-10-20T12:00:00.000Z');
  const replayed = replayWordJournal(journal, 'UTC', now).state;
  assert.deepEqual(replayed.fsrsCard, state.fsrsCard);
  assert.equal(replayed.nextReview, state.nextReview);
  assert.deepEqual(replayed.fsrsReviews, state.fsrsReviews);
  assert.deepEqual(journal, original);
  assert.deepEqual(replayWordJournal(journal, 'UTC', now).state, replayed);
});

test('removing a proven passive recall replays later cards with their saved policy and fresh input snapshots', () => {
  const baseline = empty();
  const passive = submitFsrsReview(baseline, 3, at);
  const laterAt = new Date('2026-10-02T12:00:00.000Z');
  const state = flashcard(passive, 3, laterAt, intensive);
  const original = structuredClone(state);
  const day: DailyWordEvidence = { userId: state.userId, wordId: state.wordId,
    localDate: '2026-10-01', pendingGrade: 'Good', clickedOccurrenceCount: 0,
    validExposureCount: 1, articleCount: 1, finalizedAt: '2026-10-01T23:59:59.999Z',
    articleEvidence: [{ userId: state.userId, wordId: state.wordId, articleId: 'passive-reading',
      localDate: '2026-10-01', firstSeenAt: at.toISOString(), lastSeenAt: at.toISOString(),
      validExposureCount: 1, clickedOccurrenceCount: 0 }] };
  const expected = flashcard(baseline, 3, laterAt, intensive);
  const repaired = repairPassiveReadingRecall(state, [day], 'UTC', new Date('2026-10-20T12:00:00.000Z'));
  assert.deepEqual(repaired.fsrsCard, expected.fsrsCard);
  assert.equal(repaired.fsrsReviews.length, 1);
  assert.deepEqual(repaired.fsrsReviews[0].scheduling, intensive);
  assert.deepEqual(repaired.fsrsReviews[0].beforeCard, baseline.fsrsCard);
  assert.deepEqual(repaired.passiveReadingReviews, passive.fsrsReviews);
  assert.deepEqual(state, original);
});
