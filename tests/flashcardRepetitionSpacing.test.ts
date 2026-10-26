import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFlashcardQueue, getFlashcardRehearsalGap } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

const at = new Date('2026-10-25T04:00:00.000Z');
const policy = createFlashcardSchedulingPolicy();
const seconds = (value: number) => new Date(at.getTime() + value * 1000);
const fresh = (word: string) => {
  const state = initializeWordMemory('isolated-spacing', word);
  state.lastAssistedAt = new Date(at.getTime() - 86_400_000).toISOString();
  return state;
};
function rate(state: WordMemoryState, rating: 1 | 2 | 3, second: number) {
  const result = submitFsrsReview(state, rating, seconds(second), policy);
  Object.assign(result.fsrsReviews.at(-1)!, { source: 'flashcard', localDate: '2026-10-25',
    verificationAttemptIds: [`${state.wordId}:${result.fsrsCard.reps}`] });
  return result;
}
const plan = (states: WordMemoryState[], second: number, options = {}) => buildFlashcardQueue(states,
  { now: seconds(second), timezone: 'UTC', newWordLimit: null, ...options });

for (const [rating, gap] of [[1, 3], [2, 5], [3, 8]] as const) {
  test(`rating ${rating} repeats after ${gap} other answers in a ninety-word pool, including after reload`, () => {
    let states = [rate(fresh('a-target'), rating, 0),
      ...Array.from({ length: 89 }, (_, i) => fresh(`b-${String(i).padStart(2, '0')}`))];
    assert.equal(getFlashcardRehearsalGap(states[0]), gap);
    const savedDue = states[0].nextReview;
    for (let turn = 1; turn <= gap; turn += 1) {
      const card = plan(states, turn).cards[0];
      assert.notEqual(card.wordId, 'a-target', `not ready before other answer ${turn}`);
      states = states.map(state => state.wordId === card.wordId ? rate(state, 3, turn) : state);
      states = structuredClone(states); // Durable state alone reconstructs spacing; no session timer.
    }
    const snapshot = structuredClone(states);
    assert.equal(plan(states, gap).cards[0].wordId, 'a-target');
    assert.equal(plan(states, gap).cards.filter(card => card.wordId === 'a-target').length, 1);
    assert.equal(states[0].nextReview, savedDue);
    assert.deepEqual(states, snapshot, 'queue ordering never rewrites model, history or due');
  });
}

test('a small pool shortens the gap and a single word never waits on a timer', () => {
  const first = rate(fresh('a-target'), 1, 0);
  const second = fresh('b-peer');
  assert.equal(plan([first, second], 0).cards[0].wordId, 'b-peer');
  assert.equal(plan([first, rate(second, 3, 1)], 1).cards[0].wordId, 'a-target');
  assert.equal(plan([first], 1, { newWordLimit: 0 }).cards[0].wordId, 'a-target');
});

test('duplicate attempts and correction audits do not shorten the gap', () => {
  const target = rate(fresh('a-target'), 1, 0);
  const peer = rate(fresh('b-peer'), 3, 1);
  const review = peer.fsrsReviews[0];
  review.flashcardRevisions = [{ correctionId: 'correction', revision: 1,
    previousRating: 2, rating: 3, correctedAt: seconds(1).toISOString() }];
  peer.fsrsReviews.push(structuredClone(review), structuredClone(review));
  const states = [target, peer, fresh('c-peer'), fresh('d-peer'), fresh('e-peer')];
  assert.notEqual(plan(states, 1).cards[0].wordId, target.wordId);
  states[2] = rate(states[2], 3, 2);
  assert.notEqual(plan(states, 2).cards[0].wordId, target.wordId);
  states[3] = rate(states[3], 3, 3);
  assert.equal(plan(states, 3).cards[0].wordId, target.wordId);
});

test('a corrected grade changes only the spacing rule and is not a new intervening answer', () => {
  const target = rate(fresh('a-target'), 2, 0);
  const states = [target, ...['b', 'c', 'd'].map((word, index) => rate(fresh(word), 3, index + 1)), fresh('e'), fresh('f')];
  assert.notEqual(plan(states, 3).cards[0].wordId, target.wordId);
  target.fsrsReviews[0].rating = 1;
  assert.equal(plan(states, 3).cards[0].wordId, target.wordId);
  assert.equal(target.fsrsReviews.length, 1);
});

test('lookups, future answers and duplicate canonical aliases cannot supply intervening answers', () => {
  const target = rate(fresh('a-target'), 1, 0);
  const peer = rate(fresh('run'), 3, 1);
  const alias = structuredClone(peer); alias.wordId = 'running';
  const lookup = rate(fresh('lookup'), 3, 2); lookup.fsrsReviews[0].source = 'reading_lookup';
  const future = rate(fresh('future'), 3, 100);
  const states = [target, peer, alias, lookup, future, fresh('b-new'), fresh('c-new'), fresh('d-new')];
  const queue = plan(states, 3, { canonicalWordIds: new Map([['running', 'run']]) });
  assert.notEqual(queue.cards[0].wordId, target.wordId);
  assert.equal(queue.cards.filter(card => card.canonicalWordId === 'run').length, 1);
});

test('paused and excluded repetitions stay out; short-term practice ignores an exhausted new allowance', () => {
  const target = rate(fresh('a-target'), 1, 0);
  const other = rate(fresh('b-peer'), 3, 1);
  assert.deepEqual(plan([target, other], 1, { pausedWordIds: new Set(['a-target']),
    excludedWordIds: new Set(['b-peer']) }).cards, []);
  assert.deepEqual(plan([target, fresh('new')], 1, { newWordLimit: 0 }).cards.map(card => card.wordId), ['a-target']);
});

test('a mature Hard keeps its future FSRS due and is not inserted as short-term practice', () => {
  let mature = submitFsrsReview(fresh('mature'), 4, new Date(at.getTime() - 30 * 86_400_000), policy);
  mature = rate(mature, 2, 0);
  assert.equal(mature.fsrsCard.state, 2);
  assert.equal(getFlashcardRehearsalGap(mature), null);
  assert.ok(Date.parse(mature.nextReview) > at.getTime());
  assert.deepEqual(plan([mature], 0).cards, []);
});
