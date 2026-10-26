import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { projectWordProficiency } from '../src/lib/memoryV2/wordProficiency';
import { selectWordMemoryState } from '../src/lib/wordMemoryDetails';
import { projectCanonicalWordProficiency } from '../src/lib/learningWordProficiency';
import { buildFlashcardQueue } from '../src/lib/flashcardReview';
import { buildForgettingCurveModel } from '../src/lib/forgettingCurve';

const now = new Date('2026-10-24T12:00:00Z');
const preferences = { dailyNewWordLimit: 10, importedWordIds: [] };
function word(id: string, repetitions: number) {
  let state = initializeWordMemory('u', id);
  for (let i = 0; i < repetitions; i++) {
    state = submitFsrsReview(state, 3, now);
    state.fsrsReviews.at(-1)!.source = 'flashcard';
  }
  state.nextReview = state.fsrsCard.due = now.toISOString();
  return state;
}

test('same-time aliases select the same memory in cards, details, overview and curves, regardless of input order', () => {
  const lower = word('running', 1), higher = word('runs', 2);
  for (const states of [[lower, higher], [higher, lower]]) {
    const ids = states.map(() => 'run');
    const canonical = new Map(states.map(state => [state.wordId, 'run']));
    const queue = buildFlashcardQueue(states, { now, timezone: 'UTC', canonicalWordIds: canonical });
    assert.equal(queue.cards[0].state, higher);
    assert.equal(selectWordMemoryState(states, ids, 'run'), higher);
    const view = projectCanonicalWordProficiency(states.map(state => projectWordProficiency(state, preferences, now)), ids).get('run')!;
    assert.equal(view.fsrsReps, 2);
    assert.equal(view.memoryScore, projectWordProficiency(higher, preferences, now).memoryScore);
    assert.equal(buildForgettingCurveModel(states, { now, canonicalWordIds: canonical, currentWordId: 'run' }).personal.currentWord.stabilityDays, higher.stability);
  }
});

test('canonical owner always wins and an alias enrollment or pause applies to that whole word', () => {
  const canonical = word('run', 1), alias = word('running', 2);
  const ids = new Map([['run', 'run'], ['running', 'run']]);
  assert.equal(buildFlashcardQueue([alias, canonical], { now, timezone: 'UTC', canonicalWordIds: ids }).cards[0].state, canonical);
  assert.equal(buildFlashcardQueue([alias, canonical], { now, timezone: 'UTC', canonicalWordIds: ids, pausedWordIds: new Set(['running']) }).cards.length, 0);
  const fresh = initializeWordMemory('u', 'run');
  assert.equal(buildFlashcardQueue([fresh], { now, timezone: 'UTC', canonicalWordIds: ids, enrolledWordIds: new Set(['running']) }).cards[0].kind, 'new');
});
