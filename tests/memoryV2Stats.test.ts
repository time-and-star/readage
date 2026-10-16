import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initializeWordMemory,
  submitFsrsReview,
} from '../src/lib/memoryV2';
import {
  DEFAULT_REVIEW_QUEUE_LIMIT,
  MemorySystemV2,
} from '../src/lib/memoryV2/memorySystem';
import type { MemoryStorage } from '../src/lib/memoryV2/storage';
import type { WordMemoryState } from '../src/lib/memoryV2/types';
import { buildFlashcardQueue } from '../src/lib/flashcardReview';
import type { FlashcardStudyPreferences } from '../src/lib/flashcardPreferences';

function storageWithStates(states: WordMemoryState[], preferences: FlashcardStudyPreferences = { dailyNewWordLimit: 10, importedWordIds: [] }): MemoryStorage {
  return {
    async getAllMemoryStates() {
      return states;
    },
    async getMemoryState(_userId: string, wordId: string) { return states.find(state => state.wordId === wordId) ?? null; },
    async getBatchMemoryStates(_userId: string, wordIds: string[]) { return new Map(states.filter(state => wordIds.includes(state.wordId)).map(state => [state.wordId, state])); },
    async getMeta() { return { version: 1, userId: 'user-1', ...preferences }; },
  } as unknown as MemoryStorage;
}

function makeDueState(wordId: string, reviewAt: string): WordMemoryState {
  const initial = initializeWordMemory('user-1', wordId);
  const reviewed = submitFsrsReview(initial, 'Good', new Date(reviewAt));
  const dueAt = '2026-08-01T00:00:00.000Z';
  return {
    ...reviewed,
    nextReview: dueAt,
    fsrsCard: {
      ...reviewed.fsrsCard,
      due: dueAt,
    },
  };
}

test('newly introduced words do not count as due and stats separate each state', async () => {
  const introduced = initializeWordMemory('user-1', 'introduced');
  introduced.lastAssistedAt = '2026-08-01T00:00:00.000Z';
  const due = makeDueState('due', '2026-07-20T00:00:00.000Z');
  const system = new MemorySystemV2(storageWithStates([introduced, due]));
  const now = new Date('2026-08-11T00:00:00.000Z');

  const stats = await system.getProficiencyStats('user-1', now);
  const dueWords = await system.getDueWords('user-1', now);

  assert.equal(stats.total, 2);
  assert.equal(stats.introducedCount, 1);
  assert.equal(stats.dueCount, 1);
  assert.equal(stats.learningCount + stats.masteredCount, 1);
  assert.deepEqual(dueWords.map((word) => word.wordId), ['due']);
  assert.equal(dueWords[0]?.isIntroduced, false);
  assert.equal(dueWords[0]?.status, 'learning');
});

test('lookup-only histories are new candidates across single, batch and all views, never due recalls', async () => {
  const lookup = makeDueState('lookup', '2026-07-20T00:00:00.000Z');
  lookup.fsrsReviews[0].source = 'reading_lookup';
  const passive = initializeWordMemory('user-1', 'passive');
  const system = new MemorySystemV2(storageWithStates([lookup, passive]));
  const now = new Date('2026-08-11T00:00:00.000Z');
  const single = await system.getWordProficiency('user-1', 'lookup', now);
  const batch = await system.getBatchWordProficiency('user-1', ['lookup', 'passive'], now);
  const all = await system.getAllWordProficiency('user-1', now);
  for (const view of [single, batch.get('lookup'), all.find(word => word.wordId === 'lookup')]) {
    assert.equal(view?.isIntroduced, true);
    assert.equal(view?.isFlashcardEligible, true);
    assert.equal(view?.status, 'introduced');
  }
  assert.equal(batch.get('passive')?.isFlashcardEligible, false);
  assert.deepEqual(await system.getDueWords('user-1', now), []);
  const stats = await system.getProficiencyStats('user-1', now);
  assert.equal(stats.total, 1);
  assert.equal(stats.introducedCount, 1);
  assert.equal(stats.dueCount, 0);
});

test('statistics match the complete word-card pool even with zero daily new words and paused history', async () => {
  const lookup = makeDueState('lookup', '2026-07-20T00:00:00.000Z');
  lookup.fsrsReviews[0].source = 'reading_lookup';
  const enrolled = initializeWordMemory('user-1', 'enrolled');
  const due = makeDueState('due', '2026-07-20T00:00:00.000Z');
  due.fsrsReviews[0].source = 'flashcard';
  const paused = makeDueState('paused', '2026-07-20T00:00:00.000Z');
  const removed = makeDueState('removed', '2026-07-20T00:00:00.000Z');
  const future = makeDueState('future', '2026-07-20T00:00:00.000Z');
  future.nextReview = future.fsrsCard.due = '2026-08-12T00:00:00.000Z';
  const legacy = makeDueState('legacy', '2026-07-20T00:00:00.000Z');
  legacy.fsrsReviews = [];
  const passive = initializeWordMemory('user-1', 'passive');
  const states = [lookup, enrolled, due, paused, removed, future, legacy, passive];
  const before = structuredClone(states);
  const preferences: FlashcardStudyPreferences = { dailyNewWordLimit: 0, importedWordIds: ['enrolled'],
    pausedWordIds: ['paused'], excludedWordIds: ['removed'] };
  const system = new MemorySystemV2(storageWithStates(states, preferences));
  const now = new Date('2026-08-11T00:00:00.000Z');
  const stats = await system.getProficiencyStats('user-1', now);
  const queue = buildFlashcardQueue(states, { now, timezone: 'UTC', newWordLimit: 0,
    enrolledWordIds: new Set(preferences.importedWordIds), pausedWordIds: new Set(preferences.pausedWordIds),
    excludedWordIds: new Set(preferences.excludedWordIds) });
  assert.equal(queue.newCount, 0);
  assert.equal(stats.introducedCount, queue.remainingNewCount);
  assert.equal(stats.introducedCount, 2);
  assert.equal(stats.dueCount, queue.dueCount);
  assert.equal(stats.dueCount, 2);
  assert.equal(stats.total, 5);
  assert.deepEqual((await system.getDueWords('user-1', now)).map(word => word.wordId), ['due', 'legacy']);
  assert.deepEqual(states, before);
});

test('query errors propagate for retry instead of producing an empty successful learning view', async () => {
  const storage = storageWithStates([]);
  storage.getAllMemoryStates = async () => { throw new Error('read failed'); };
  const system = new MemorySystemV2(storage);
  await assert.rejects(system.getAllWordProficiency('user-1'), /read failed/);
  await assert.rejects(system.getProficiencyStats('user-1'), /read failed/);
  await assert.rejects(system.getDueWords('user-1'), /read failed/);
});

test('due queue uses the five-word default and has stable tie ordering', async () => {
  const states = ['zeta', 'alpha', 'epsilon', 'beta', 'delta', 'gamma', 'eta']
    .map((wordId) => makeDueState(wordId, '2026-07-20T00:00:00.000Z'));
  const system = new MemorySystemV2(storageWithStates(states));
  const now = new Date('2026-08-11T00:00:00.000Z');

  assert.equal(DEFAULT_REVIEW_QUEUE_LIMIT, 5);
  const dueWords = await system.getDueWords('user-1', now, DEFAULT_REVIEW_QUEUE_LIMIT);

  assert.deepEqual(
    dueWords.map((word) => word.wordId),
    ['alpha', 'beta', 'delta', 'epsilon', 'eta'],
  );
});
