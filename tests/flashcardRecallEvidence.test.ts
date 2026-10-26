import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFlashcardQueue, classifyFlashcardRecallEvidence, getFlashcardLearningProgress } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import type { FlashcardRecallEvidence, WordMemoryState } from '../src/lib/memoryV2/types';

const at = new Date('2026-10-24T04:00:00.000Z');
const policy = createFlashcardSchedulingPolicy(0.9, 6);
const independent: FlashcardRecallEvidence = { kind: 'independent_recall' };
const practice: FlashcardRecallEvidence = { kind: 'answer_rehearsal', answerExposedAt: at.toISOString() };
const seconds = (count: number) => new Date(at.getTime() + count * 1000);
function fresh(wordId = 'remember') {
  const state = initializeWordMemory('isolated-recall-evidence', wordId);
  state.lastAssistedAt = new Date(at.getTime() - 86_400_000).toISOString();
  return state;
}
function review(state: WordMemoryState, grade: 1 | 2 | 3 | 4, now: Date, evidence = independent) {
  const result = submitFsrsReview(state, grade, now, policy, evidence);
  Object.assign(result.fsrsReviews.at(-1)!, { source: 'flashcard',
    verificationAttemptIds: [`${state.wordId}:${result.fsrsCard.reps}`] });
  return result;
}

test('the product classifies same-word answer rehearsal until another word task or sixty seconds', () => {
  assert.equal(classifyFlashcardRecallEvidence({ now: at }).kind, 'independent_recall');
  assert.deepEqual(classifyFlashcardRecallEvidence({ answerExposedAt: at.toISOString(), now: seconds(59.999) }), practice);
  assert.equal(classifyFlashcardRecallEvidence({ answerExposedAt: at.toISOString(), now: seconds(60) }).kind, 'independent_recall');
  assert.deepEqual(classifyFlashcardRecallEvidence({ answerExposedAt: at.toISOString(), interveningWord: 'another', now: seconds(1) }),
    { kind: 'independent_recall', answerExposedAt: at.toISOString(), interveningWord: 'another' });
  assert.throws(() => classifyFlashcardRecallEvidence({ answerExposedAt: 'invalid', now: at }), /Invalid answer exposure/);
});

test('a solo card finishes three practice steps while only its first recall updates memory', () => {
  const first = review(fresh(), 3, at);
  const second = review(first, 3, seconds(5), practice);
  const third = review(second, 3, seconds(10), practice);
  assert.equal(getFlashcardLearningProgress(first), 1);
  assert.equal(getFlashcardLearningProgress(second), 2);
  assert.equal(third.fsrsCard.state, 2);
  assert.equal(third.fsrsCard.reps, 3, 'attempt versions remain monotonic for the existing concurrency guard');
  assert.equal(third.fsrsReviews.length, 3);
  assert.equal(third.fsrsReviews.filter(row => row.modelApplied !== false).length, 1);
  assert.equal(third.stability, first.stability);
  assert.equal(third.difficulty, first.difficulty);
  assert.equal(third.lastReview, first.lastReview);
  assert.equal(third.fsrsCard.lastReview, first.fsrsCard.lastReview);
  assert.equal(third.fsrsCard.elapsedDays, first.fsrsCard.elapsedDays);
  assert.equal(third.fsrsCard.lapses, first.fsrsCard.lapses);
  assert.equal(third.fsrsReviews.at(-1)!.review, seconds(10).toISOString());
  assert.equal(third.fsrsCard.confirmationDue, new Date(seconds(10).getTime() + 86_400_000).toISOString());
  assert.deepEqual(buildFlashcardQueue([third], { now: seconds(10), timezone: 'UTC', newWordLimit: null }).cards, []);
});

test('Again followed by three answer rehearsals keeps its weak estimate and receives an earlier due', () => {
  const failure = review(fresh(), 1, at);
  let state = failure;
  for (let step = 1; step <= 3; step += 1) state = review(state, 3, seconds(step * 5), practice);
  assert.equal(state.fsrsCard.state, 2);
  assert.equal(state.stability, failure.stability);
  assert.equal(state.difficulty, failure.difficulty);
  assert.equal(state.lastReview, at.toISOString());
  assert.equal(state.fsrsReviews.filter(row => row.modelApplied !== false).length, 1);
  assert.ok(Date.parse(state.nextReview) > seconds(15).getTime());
  assert.ok(Date.parse(state.nextReview) < Date.parse(state.fsrsCard.confirmationDue!));
});

test('practice Hard preserves steps and practice Again resets steps without changing formal memory', () => {
  const first = review(fresh(), 3, at);
  const hard = review(first, 2, seconds(5), practice);
  const again = review(hard, 1, seconds(10), practice);
  assert.equal(getFlashcardLearningProgress(hard), 1);
  assert.equal(getFlashcardLearningProgress(again), 0);
  assert.equal(again.stability, first.stability);
  assert.equal(again.difficulty, first.difficulty);
  assert.equal(again.lastReview, first.lastReview);
  assert.equal(again.fsrsCard.reps, 3);
});

test('an independent same-day recall still updates the model and frozen V5 ignores the new practice classification', () => {
  const first = review(fresh(), 1, at);
  const later = review(first, 3, seconds(60));
  assert.equal(later.fsrsReviews.at(-1)!.modelApplied, undefined);
  assert.equal(later.lastReview, seconds(60).toISOString());
  assert.notEqual(later.stability, first.stability);
  const v5 = submitFsrsReview(first, 3, seconds(5), createFlashcardSchedulingPolicy(0.9, 5), practice);
  assert.equal(v5.fsrsReviews.at(-1)!.modelApplied, undefined);
  assert.equal(v5.lastReview, seconds(5).toISOString());
  assert.notEqual(v5.stability, first.stability);
});

test('round rotation uses actual practice times while formal recall timestamps remain unchanged', () => {
  const a = review(review(fresh('a'), 3, seconds(3)), 3, seconds(9), practice);
  const b = review(review(fresh('b'), 3, at), 3, seconds(10), practice);
  assert.equal(a.lastReview, seconds(3).toISOString());
  assert.equal(b.lastReview, at.toISOString());
  const plan = buildFlashcardQueue([b, a], { now: seconds(10), timezone: 'UTC', newWordLimit: null });
  assert.deepEqual(plan.cards.map(card => card.wordId), ['a', 'b']);
});

test('an earlier model recall retains its next-day confirmation until the confirmation is reached', () => {
  let state = review(fresh(), 1, at);
  for (let step = 1; step <= 3; step += 1) state = review(state, 3, seconds(step * 5), practice);
  const checkpoint = state.fsrsCard.confirmationDue!;
  state = review(state, 3, new Date(state.nextReview));
  assert.equal(state.fsrsCard.confirmationDue, checkpoint);
  assert.ok(Date.parse(state.nextReview) <= Date.parse(checkpoint));
  state = review(state, 3, new Date(checkpoint));
  assert.equal(state.fsrsCard.confirmationDue, undefined);
  assert.ok(Date.parse(state.nextReview) > Date.parse(checkpoint));
});
