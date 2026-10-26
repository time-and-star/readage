import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFlashcardQueue, getFlashcardLearningProgress } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { reconcileFlashcardSession } from '../src/lib/flashcardSessionSettings';

const now = new Date('2026-10-23T12:00:00.000Z');
function shortTerm(wordId: string, due: string, state: 1 | 3 = 1, steps = 1) {
  const result = submitFsrsReview(initializeWordMemory('isolated-intraday-queue', wordId), 3,
    new Date('2026-10-23T11:59:00.000Z'), createFlashcardSchedulingPolicy(0.9, 1));
  result.fsrsReviews[0].source = 'flashcard';
  result.fsrsReviews[0].localDate = '2026-10-23';
  result.nextReview = due;
  Object.assign(result.fsrsCard, { due, state, learningSteps: steps });
  return result;
}

test('future short-term cards remain pending and return exactly at their persisted due time', () => {
  const card = shortTerm('remember', '2026-10-23T12:01:00.000Z');
  const before = buildFlashcardQueue([card], { now, timezone: 'UTC', newWordLimit: 0 });
  assert.equal(before.cards.length, 0);
  assert.equal(before.learningCount, 1);
  assert.equal(before.pendingLearningCount, 1);
  assert.equal(before.nextLearningDueAt, card.nextReview);
  assert.equal(before.newIntroducedToday, 1);
  const due = buildFlashcardQueue([structuredClone(card)], { now: new Date(card.nextReview), timezone: 'UTC', newWordLimit: 0 });
  assert.deepEqual(due.cards.map(row => [row.wordId, row.kind]), [['remember', 'learning']]);
  assert.equal(due.pendingLearningCount, 0);
  assert.equal(due.learningCount, 1);
  assert.equal(due.newIntroducedToday, 1);
});

test('short-term waiting counts exclude long-term reviews, paused words and canonical duplicates', () => {
  const run = shortTerm('run', '2026-10-23T12:03:00.000Z');
  const alias = shortTerm('running', '2026-10-23T12:01:00.000Z');
  const paused = shortTerm('paused', '2026-10-23T12:02:00.000Z');
  const longTerm = shortTerm('long-term', '2026-10-24T12:00:00.000Z');
  longTerm.fsrsCard.state = 2;
  const result = buildFlashcardQueue([alias, run, paused, longTerm], { now, timezone: 'UTC',
    canonicalWordIds: new Map([['running', 'run']]), pausedWordIds: new Set(['paused']) });
  assert.equal(result.learningCount, 1);
  assert.equal(result.pendingLearningCount, 1);
  assert.equal(result.nextLearningDueAt, run.nextReview);
  const removed = buildFlashcardQueue([run, alias], { now, timezone: 'UTC',
    canonicalWordIds: new Map([['running', 'run']]), excludedWordIds: new Set(['running']) });
  assert.equal(removed.learningCount, 0);
  assert.equal(removed.nextLearningDueAt, null);
});

test('short-term steps crossing midnight remain pending instead of disappearing from today', () => {
  const card = shortTerm('remember', '2026-10-23T16:01:00.000Z', 3, 0);
  const before = buildFlashcardQueue([card], { now: new Date('2026-10-23T15:59:00Z'), timezone: 'Asia/Shanghai' });
  assert.equal(before.pendingLearningCount, 1);
  assert.equal(before.nextLearningDueAt, card.nextReview);
  const nextDay = buildFlashcardQueue([card], { now: new Date(card.nextReview), timezone: 'Asia/Shanghai' });
  assert.equal(nextDay.cards[0].kind, 'relearning');
  assert.equal(nextDay.newIntroducedToday, 0);
});

test('current policy progress uses saved learning steps without mutating historical records', () => {
  const fresh = initializeWordMemory('isolated-intraday-queue', 'fresh');
  assert.equal(getFlashcardLearningProgress(fresh, true), 0);
  for (const kind of [1, 3] as const) {
    for (const steps of [0, 1, 2]) {
      const card = shortTerm('remember', '2026-10-23T12:01:00Z', kind, steps);
      const before = structuredClone(card);
      assert.equal(getFlashcardLearningProgress(card), steps);
      assert.deepEqual(card, before);
    }
  }
  const graduated = shortTerm('remember', '2026-10-24T12:00:00Z');
  graduated.fsrsCard.state = 2;
  assert.equal(getFlashcardLearningProgress(graduated), null);
});

test('a newly due learning card joins the queue without replacing the visible saved answer', () => {
  const active = buildFlashcardQueue([shortTerm('active', now.toISOString())], { now, timezone: 'UTC' }).cards[0];
  const returned = buildFlashcardQueue([shortTerm('returned', now.toISOString(), 3, 0)], { now, timezone: 'UTC' }).cards[0];
  const reconciled = reconcileFlashcardSession([active], [returned], new Set(), true);
  assert.equal(reconciled[0], active);
  assert.deepEqual(reconciled.map(row => row.wordId), ['active', 'returned']);
  assert.equal(reconcileFlashcardSession([], [returned], new Set(['returned']), false).length, 0);
});
