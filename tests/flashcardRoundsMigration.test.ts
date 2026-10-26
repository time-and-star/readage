import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { submitFlashcardRating } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { importAndVerifyItem, parseMigrationItem } from '../src/lib/memoryV2/indexedDbImpl';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { readVerificationHistory } from '../src/lib/memoryV2/verificationMemory';
import type { ReadingVerificationEvidence, WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const at = new Date('2026-10-23T04:00:00.000Z');
const userId = 'isolated-round-migration';
const wordId = 'remember';
const journalKey = `reading-verification:${userId}`;
const expectedIds = ['z-good', 'y-good', 'a-hard'];
const stores: MemoryV2Store[] = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function storage() {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  return new LocalStorageMemoryStorage();
}

function store(target: LocalStorageMemoryStorage) {
  const value = new MemoryV2Store({ storage: target, userId, timezone: 'UTC', now: () => at });
  stores.push(value);
  return value;
}

async function importJournal(target: LocalStorageMemoryStorage, attempts: ReadingVerificationEvidence[]) {
  const item = parseMigrationItem(`english-ai:v2:memory:meta:${journalKey}`,
    JSON.parse(JSON.stringify({ version: 1, userId, attempts })));
  assert.ok(item);
  await importAndVerifyItem(target, item);
}

for (const scenario of [
  { name: 'empty target', existingIndices: [] },
  { name: 'existing prefix', existingIndices: [0, 1] },
  { name: 'partial overlapping branch', existingIndices: [0, 2] },
]) {
  test(`policy v4 same-millisecond recall order survives migration and reopen (${scenario.name})`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: at });
    const source = storage();
    const sourceStore = store(source);
    await sourceStore.ensureReady();
    const fresh = initializeWordMemory(userId, wordId);
    fresh.lastAssistedAt = new Date(at.getTime() - 60_000).toISOString();
    fresh.nextReview = fresh.fsrsCard.due = at.toISOString();
    await source.saveMemoryState(fresh);
    let expected: WordMemoryState = fresh;
    for (const [attemptId, rating] of [['z-good', 'good'], ['y-good', 'good'], ['a-hard', 'hard']] as const) {
      expected = await submitFlashcardRating(sourceStore, { attemptId, wordId, rating, scheduling: createFlashcardSchedulingPolicy(0.9, 4) });
    }
    const attempts = await readVerificationHistory(source, userId);
    assert.deepEqual(attempts.map(attempt => attempt.attemptId), expectedIds);
    assert.equal(new Set(attempts.map(attempt => attempt.occurredAt)).size, 1);
    assert.ok(attempts.every(attempt => attempt.scheduling?.version === 4));
    assert.equal(expected.fsrsCard.learningSteps, 0);
    sourceStore.dispose();

    const target = storage();
    if (scenario.existingIndices.length) await importJournal(target, scenario.existingIndices.map(index => attempts[index]));
    const stateItem = parseMigrationItem(`english-ai:v2:memory:state:${userId}:${wordId}`, JSON.parse(JSON.stringify(expected)));
    assert.ok(stateItem);
    await importAndVerifyItem(target, stateItem);
    await importJournal(target, attempts);
    const migratedIds = (await readVerificationHistory(target, userId)).map(attempt => attempt.attemptId);
    const reopenedStore = store(new LocalStorageMemoryStorage());
    await reopenedStore.ensureReady();
    const reopened = (await reopenedStore.system.getReadingVerificationMemoryStates(userId)).find(state => state.wordId === wordId)!;
    assert.ok(reopened);
    assert.equal(reopened.fsrsCard.learningSteps, expected.fsrsCard.learningSteps,
      `migration reordered ${expectedIds.join(' → ')} into ${migratedIds.join(' → ')}`);
    assert.deepEqual(reopened.fsrsCard, expected.fsrsCard);
    assert.deepEqual(reopened.fsrsReviews, expected.fsrsReviews);
    assert.deepEqual(migratedIds, expectedIds);
    await importJournal(target, attempts);
    assert.deepEqual((await readVerificationHistory(target, userId)).map(attempt => attempt.attemptId), expectedIds);
  });
}

test('conflicting v4 same-time source orders stop before overwriting the journal or memory state', async () => {
  const target = storage();
  const attempts: ReadingVerificationEvidence[] = expectedIds.map((attemptId, index) => ({
    attemptId, questionId: `flashcard:v1:${wordId}`, wordId, articleId: 'flashcard-review',
    purpose: 'flashcard_review', outcome: index === 2 ? 'uncertain' : 'recognized', rating: index === 2 ? 2 : 3,
    userId, occurredAt: at.toISOString(), localDate: '2026-10-23', timezone: 'UTC',
    scheduling: { version: 4, desiredRetention: 0.9 },
  }));
  await importJournal(target, attempts);
  const beforeJournal = await target.getMeta(journalKey);
  const beforeState = initializeWordMemory(userId, wordId);
  await target.saveMemoryState(beforeState);
  await assert.rejects(importJournal(target, [...attempts].reverse()), /Conflicting same-time flashcard review order/);
  assert.deepEqual(await target.getMeta(journalKey), beforeJournal);
  assert.deepEqual(await target.getMemoryState(userId, wordId), beforeState);
});

test('historical policies retain their original same-time attempt-ID tie ordering', async () => {
  const target = storage();
  const attempts: ReadingVerificationEvidence[] = [1, 2, 3].map((version, index) => ({
    attemptId: expectedIds[index], questionId: `flashcard:v1:${wordId}`, wordId, articleId: 'flashcard-review',
    purpose: 'flashcard_review', outcome: 'recognized', rating: 3, userId,
    occurredAt: at.toISOString(), localDate: '2026-10-23', timezone: 'UTC',
    scheduling: { version: version as 1 | 2 | 3, desiredRetention: 0.9 },
  }));
  await importJournal(target, attempts);
  assert.deepEqual((await readVerificationHistory(target, userId)).map(attempt => attempt.attemptId), [...expectedIds].sort());
});

test('v4 order is restored only into its own bucket slots while old buckets and different timestamps retain their ordering', async () => {
  const target = storage();
  const base: ReadingVerificationEvidence = {
    attemptId: '', questionId: `flashcard:v1:${wordId}`, wordId, articleId: 'flashcard-review',
    purpose: 'flashcard_review', outcome: 'recognized', rating: 3, userId,
    occurredAt: at.toISOString(), localDate: '2026-10-23', timezone: 'UTC',
    scheduling: { version: 4, desiredRetention: 0.9 },
  };
  const rounds = expectedIds.map(attemptId => ({ ...base, attemptId }));
  const old = ['c-old', 'b-old'].map((attemptId, index) => ({ ...base, attemptId, wordId: 'historical-word',
    scheduling: { version: index === 0 ? 1 as const : 3 as const, desiredRetention: 0.9 } }));
  const earlier = { ...base, attemptId: 'q-earlier', occurredAt: new Date(at.getTime() - 1).toISOString() };
  const later = { ...base, attemptId: 'd-later', occurredAt: new Date(at.getTime() + 1).toISOString() };
  await importJournal(target, [later, rounds[0], old[0], rounds[1], old[1], rounds[2], earlier]);
  assert.deepEqual((await readVerificationHistory(target, userId)).map(attempt => attempt.attemptId),
    ['q-earlier', 'z-good', 'b-old', 'c-old', 'y-good', 'a-hard', 'd-later']);
});
