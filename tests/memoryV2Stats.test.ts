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

function storageWithStates(states: WordMemoryState[]): MemoryStorage {
  return {
    async getAllMemoryStates() {
      return states;
    },
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
