import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFlashcardQueue, getFlashcardLearningProgress, getFlashcardRehearsalGap, previewFlashcardIntervals } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy, isFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

const at = new Date('2026-10-23T04:00:00.000Z');
const day = 86_400_000;
const policy = createFlashcardSchedulingPolicy(0.9, 4);
function fresh(wordId: string) {
  const state = initializeWordMemory('isolated-rounds', wordId);
  state.lastAssistedAt = new Date(at.getTime() - day).toISOString();
  return state;
}
function rate(state: WordMemoryState, rating: 1 | 2 | 3 | 4, when = at) {
  const result = submitFsrsReview(state, rating, when, policy);
  Object.assign(result.fsrsReviews.at(-1)!, { source: 'flashcard', localDate: '2026-10-23',
    verificationAttemptIds: [`${state.wordId}:${result.fsrsCard.reps}`] });
  return result;
}
const queue = (states: WordMemoryState[], options = {}) => buildFlashcardQueue(states,
  { now: at, timezone: 'UTC', newWordLimit: null, ...options });

test('new default uses rounds, keeps all frozen historical policies and rejects unknown versions', () => {
  assert.deepEqual(createFlashcardSchedulingPolicy(), { version: 6, desiredRetention: 0.9 });
  for (const version of [1, 2, 3, 4, 5, 6] as const) assert.ok(isFlashcardSchedulingPolicy(createFlashcardSchedulingPolicy(0.93, version)));
  assert.equal(isFlashcardSchedulingPolicy({ version: 7, desiredRetention: 0.9 }), false);
});

test('three genuine recalls can complete the short-term phase without any clock advancement', () => {
  let state = fresh('remember');
  for (let step = 1; step <= 3; step += 1) {
    const preview = previewFlashcardIntervals(state, at).good;
    state = rate(state, 3);
    assert.equal(state.nextReview, preview.nextReview);
    assert.equal(state.fsrsCard.reps, step);
    assert.equal(state.fsrsCard.state, step === 3 ? 2 : 1);
    assert.equal(getFlashcardLearningProgress(state), step === 3 ? null : step);
    assert.equal(getFlashcardRehearsalGap(state), step === 3 ? null : 8);
    assert.equal(Date.parse(state.nextReview) - at.getTime(), step === 3 ? day : 0);
    assert.equal(queue([state]).cards.length, step === 3 ? 0 : 1);
    assert.equal(queue([state]).pendingLearningCount, 0);
  }
});

test('ten cards rotate through three full rounds even when all attempts have the same timestamp', () => {
  const states = Array.from({ length: 10 }, (_, index) => fresh(`word-${index}`));
  const seen: string[] = [];
  for (let turn = 0; turn < 30; turn += 1) {
    const plan = queue(states);
    const current = plan.cards[0];
    assert.ok(current);
    assert.equal(plan.pendingLearningCount, 0);
    seen.push(current.wordId);
    states[states.findIndex(state => state.wordId === current.wordId)] = rate(current.state, 3);
  }
  const firstPass = seen.slice(0, 10);
  assert.equal(new Set(firstPass).size, 10);
  assert.deepEqual(seen.slice(10, 20), firstPass);
  assert.deepEqual(seen.slice(20), firstPass);
  assert.deepEqual(queue(states).cards, []);
  assert.ok(states.every(state => state.fsrsCard.reps === 3));
});

for (const rating of [1, 2] as const) {
  test(`${rating === 1 ? 'Again' : 'Hard'} resets consecutive successes but retains the round and does not starve peers`, () => {
    const first = rate(rate(fresh('a'), 3), 3);
    const second = rate(rate(fresh('b'), 3), 3);
    const reset = rate(first, rating);
    assert.equal(reset.fsrsCard.learningSteps, 0);
    assert.equal(getFlashcardLearningProgress(reset), 0);
    assert.equal(reset.fsrsCard.reps, 3);
    assert.deepEqual(queue([reset, second]).cards.map(card => card.wordId), ['b', 'a']);
    let state = reset;
    for (let step = 0; step < 3; step += 1) state = rate(state, 3);
    assert.equal(state.fsrsCard.state, 2);
    assert.equal(state.fsrsCard.reps, 6);
    assert.equal(state.fsrsCard.lapses, 0);
  });
}

test('an unfinished word continues when the daily new allowance is exhausted', () => {
  let learned = rate(fresh('a'), 3);
  const untouched = fresh('b');
  for (let step = 1; step < 3; step += 1) {
    const plan = queue([untouched, learned], { newWordLimit: 1 });
    assert.equal(plan.newIntroducedToday, 1);
    assert.equal(plan.newCount, 0);
    assert.deepEqual(plan.cards.map(card => card.wordId), ['a']);
    learned = rate(learned, 3);
  }
  assert.deepEqual(queue([untouched, learned], { newWordLimit: 1 }).cards, []);
});

test('canonical aliases, pauses and exclusions do not create extra turns or consume another introduction', () => {
  const canonical = rate(fresh('run'), 3);
  const alias = rate(rate(fresh('running'), 3), 3);
  const options = { canonicalWordIds: new Map([['running', 'run']]) };
  assert.deepEqual(queue([alias, canonical], options).cards.map(card => card.wordId), ['run']);
  assert.equal(queue([alias, canonical], options).newIntroducedToday, 1);
  assert.deepEqual(queue([alias, canonical], { ...options, pausedWordIds: new Set(['run']) }).cards, []);
  assert.deepEqual(queue([alias, canonical], { ...options, excludedWordIds: new Set(['running']) }).cards, []);
});

test('a mature word starts a new relearning round rather than carrying its lifetime repetitions', () => {
  let mature = submitFsrsReview(fresh('mature'), 4, new Date(at.getTime() - 30 * day), createFlashcardSchedulingPolicy(0.9, 1));
  mature.fsrsReviews[0].source = 'flashcard';
  mature.fsrsCard.reps = 100;
  mature = rate(mature, 2);
  const novice = rate(rate(fresh('novice'), 3), 3);
  assert.equal(mature.fsrsCard.state, 3);
  assert.deepEqual(queue([novice, mature]).cards.map(card => card.wordId), ['mature', 'novice']);
});

test('a duplicate attempt or a correction audit is not an extra round', () => {
  const first = rate(fresh('a'), 3);
  const second = rate(rate(fresh('b'), 3), 3);
  first.fsrsReviews.push(structuredClone(first.fsrsReviews[0]));
  first.fsrsReviews[1].flashcardRevisions = [{ correctionId: 'revision', revision: 1,
    previousRating: 1, rating: 3, correctedAt: at.toISOString() }];
  assert.deepEqual(queue([second, first]).cards.map(card => card.wordId), ['a', 'b']);
});

test('historical timed short-term cards preserve their saved due until the next real rating', () => {
  const historical = submitFsrsReview(fresh('old'), 3, at, createFlashcardSchedulingPolicy(0.9, 3));
  historical.fsrsReviews[0].source = 'flashcard';
  const snapshot = structuredClone(historical);
  assert.equal(getFlashcardRehearsalGap(historical), null);
  assert.equal(queue([historical]).cards.length, 0);
  assert.equal(queue([historical]).pendingLearningCount, 1);
  assert.deepEqual(historical, snapshot);
  const next = rate(historical, 3, new Date(historical.nextReview));
  assert.equal(getFlashcardRehearsalGap(next), 8);
  assert.equal(next.nextReview, next.lastReview);
});

test('a successful mature review keeps ordinary cross-day FSRS scheduling', () => {
  const mature = submitFsrsReview(fresh('steady'), 4, new Date(at.getTime() - 30 * day), createFlashcardSchedulingPolicy(0.9, 1));
  const preview = previewFlashcardIntervals(mature, at).good;
  const result = rate(mature, 3);
  assert.equal(result.fsrsCard.state, 2);
  assert.equal(preview.rehearsalGap, null);
  assert.equal(result.nextReview, preview.nextReview);
  assert.ok(preview.intervalMs > day);
});
