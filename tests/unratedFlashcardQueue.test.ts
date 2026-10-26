import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFlashcardQueue, getFlashcardLearningProgress, getFlashcardRehearsalGap, getManagedFlashcardWordIds } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { projectUnratedFlashcardPractice } from '../src/lib/flashcardPractice';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { hasFormalRecallEvidence } from '../src/lib/memoryV2/rmeV4Bridge';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

const at = new Date('2026-10-24T04:00:00.000Z');
const day = 86_400_000;
const policy = createFlashcardSchedulingPolicy(0.9, 6);
const seconds = (count: number) => new Date(at.getTime() + count * 1000);
function fresh(wordId: string) {
  const state = initializeWordMemory('isolated-unrated-queue', wordId);
  state.lastAssistedAt = new Date(at.getTime() - 10_000).toISOString();
  return state;
}
function practice(state: WordMemoryState, rating: 1 | 2 | 3, when = at) {
  const result = submitFsrsReview(state, rating, when, policy,
    { kind: 'answer_rehearsal', answerExposedAt: state.lastAssistedAt });
  Object.assign(result.fsrsReviews.at(-1)!, { source: 'flashcard', localDate: when.toISOString().slice(0, 10),
    verificationAttemptIds: [`${state.wordId}:${result.fsrsCard.reps}`] });
  return result;
}
const queue = (states: WordMemoryState[], now = at, options = {}) => buildFlashcardQueue(states,
  { now, timezone: 'UTC', newWordLimit: null, ...options });

test('an unverified practice is an active learning card, consumes one introduction, and continues with no new allowance', () => {
  const state = practice(fresh('adapt'), 3);
  const plan = queue([state, fresh('adopt')], at, { newWordLimit: 1 });
  assert.equal(hasFormalRecallEvidence(state), false);
  assert.equal(state.fsrsCard.state, 0);
  assert.equal(state.stability, 0);
  assert.equal(plan.newIntroducedToday, 1);
  assert.equal(plan.newCount, 0);
  assert.equal(plan.remainingNewCount, 1);
  assert.equal(plan.learningCount, 1);
  assert.deepEqual(plan.cards.map(card => [card.wordId, card.kind]), [['adapt', 'learning']]);
  assert.equal(getFlashcardLearningProgress(state), 1);
  assert.equal(getFlashcardLearningProgress(state, true), 1, 'saved practice overrides a stale new-card front');
  assert.equal(getFlashcardRehearsalGap(state), 8);
  assert.deepEqual(queue([state], at, { newWordLimit: 0 }).cards.map(card => card.wordId), ['adapt']);
});

test('three unverified rehearsals leave the new-word pool and wait for the persisted confirmation', () => {
  let state = fresh('adapt');
  for (let step = 0; step < 3; step += 1) state = practice(state, 3, seconds(step * 5));
  const overlay = projectUnratedFlashcardPractice(state)!;
  assert.equal(overlay.phase, 'confirmation');
  assert.equal(overlay.steps, 3);
  assert.equal(state.lastReview, null);
  assert.equal(state.fsrsCard.state, 0);
  assert.equal(getFlashcardLearningProgress(state), null);
  assert.equal(getFlashcardRehearsalGap(state), null);
  const waiting = queue([state], seconds(10));
  assert.deepEqual(waiting.cards, []);
  assert.equal(waiting.remainingNewCount, 0);
  assert.equal(waiting.newIntroducedToday, 1);
  assert.equal(waiting.nextDueAt, overlay.due);
  const due = queue([state], new Date(overlay.due), { newWordLimit: 0 });
  assert.deepEqual(due.cards.map(card => [card.wordId, card.kind, card.nextReview]), [['adapt', 'due', overlay.due]]);
});

test('repeated practice counts one daily introduction and yesterday practice does not consume today allowance', () => {
  let state = practice(fresh('adapt'), 3, new Date(at.getTime() - day));
  state = practice(state, 2, at);
  const plan = queue([state, fresh('adopt')], at, { newWordLimit: 1 });
  assert.equal(plan.newIntroducedToday, 0);
  assert.equal(plan.newCount, 1);
  assert.equal(plan.cards.filter(card => card.wordId === 'adapt').length, 1);
});

test('unverified practice rounds rotate by attempts even when Hard retains progress and Again resets it', () => {
  const a = practice(practice(fresh('a'), 3), 1, seconds(2));
  const b = practice(fresh('b'), 3, seconds(1));
  assert.equal(getFlashcardLearningProgress(a), 0);
  assert.deepEqual(queue([a, b], seconds(2)).cards.map(card => card.wordId), ['b', 'a']);
  const bNext = practice(b, 2, seconds(3));
  assert.equal(getFlashcardLearningProgress(bNext), 1);
  assert.deepEqual(queue([bNext, a], seconds(3)).cards.map(card => card.wordId), ['a', 'b']);
});

test('canonical aliases, pauses, and exclusions keep one unverified practice identity', () => {
  const canonical = practice(fresh('run'), 3);
  const alias = practice(practice(fresh('running'), 3), 3);
  const options = { canonicalWordIds: new Map([['running', 'run']]) };
  const plan = queue([alias, canonical], at, options);
  assert.deepEqual(plan.cards.map(card => card.wordId), ['run']);
  assert.equal(plan.newIntroducedToday, 1);
  assert.deepEqual(queue([canonical], at, { pausedWordIds: new Set(['run']) }).cards, []);
  assert.deepEqual(queue([canonical], at, { excludedWordIds: new Set(['run']) }).cards, []);
  assert.deepEqual(getManagedFlashcardWordIds([canonical], { dailyNewWordLimit: 0, importedWordIds: [] }, new Map()), ['run']);
});
