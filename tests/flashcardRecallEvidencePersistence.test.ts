import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { readVerificationHistory } from '../src/lib/memoryV2/verificationMemory';
import type { FlashcardRecallEvidence, FlashcardReviewInput } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const userId = 'isolated-recall-evidence';
const policy = createFlashcardSchedulingPolicy(0.9, 6);
const start = new Date('2026-10-23T08:00:00.000Z');
const at = (seconds: number) => new Date(start.getTime() + seconds * 1_000);
function setup() {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  const system = new MemorySystemV2(storage, undefined, 'UTC');
  const seed = async (wordId: string) => {
    const state = initializeWordMemory(userId, wordId);
    state.lastAssistedAt = '2026-10-22T08:00:00.000Z';
    await storage.saveMemoryState(state);
  };
  const answer = async (wordId: string, attemptId: string, seconds: number, rating: 1 | 2 | 3 = 3,
    evidence?: FlashcardRecallEvidence, scheduling = policy) => {
    const input: FlashcardReviewInput = { attemptId, wordId, questionId: `card:${wordId}`,
      articleId: 'word-cards', purpose: 'flashcard_review', rating,
      outcome: rating === 1 ? 'incorrect' : rating === 2 ? 'uncertain' : 'recognized',
      scheduling, expectedReps: (await storage.getMemoryState(userId, wordId))!.fsrsCard.reps,
      ...(evidence ? { evidence } : {}) };
    await system.recordVerification(userId, input, at(seconds));
    return (await storage.getMemoryState(userId, wordId))!;
  };
  return { storage, system, seed, answer };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

test('the first word-card recall initializes memory, then immediate single-word repetitions only advance practice', async () => {
  const { seed, answer, system } = setup();
  await seed('adapt');
  const first = await answer('adapt', 'first', 0);
  const second = await answer('adapt', 'second', 10);
  const third = await answer('adapt', 'third', 20);
  assert.ok(first.stability > 0);
  assert.equal(second.stability, first.stability);
  assert.equal(third.stability, first.stability);
  assert.equal(third.difficulty, first.difficulty);
  assert.equal(third.lastReview, first.lastReview);
  assert.equal(third.fsrsCard.reps, 3);
  assert.deepEqual(third.fsrsReviews.map(review => review.modelApplied), [undefined, false, false]);
  assert.deepEqual((await system.getFlashcardReviewHistory(userId)).map(row => row.purpose === 'flashcard_review' ? row.evidence?.kind : null),
    ['independent_recall', 'answer_rehearsal', 'answer_rehearsal']);
  assert.equal(third.rme?.recoveryStreak, first.rme?.recoveryStreak);
});

test('the persisted 60-second boundary permits a new independent same-day recall', async () => {
  const { seed, answer } = setup();
  await seed('adapt');
  await answer('adapt', 'first', 0);
  const saved = await answer('adapt', 'second', 60);
  assert.equal(saved.fsrsReviews.at(-1)?.evidence?.kind, 'independent_recall');
  assert.equal(saved.fsrsReviews.at(-1)?.evidence?.answerExposedAt, at(0).toISOString());
  assert.equal(saved.fsrsReviews.at(-1)?.modelApplied, undefined);
  assert.equal(saved.lastReview, at(60).toISOString());
});

for (const seconds of [0, 10]) {
  test(`a completed different word establishes independent recall, including journal ties at ${seconds}s`, async () => {
    const { seed, answer } = setup();
    await seed('adapt');
    await seed('adopt');
    await answer('adapt', 'adapt-first', 0);
    await answer('adopt', 'adopt-between', seconds);
    const saved = await answer('adapt', 'adapt-second', seconds);
    assert.equal(saved.fsrsReviews.at(-1)?.evidence?.kind, 'independent_recall');
    assert.equal(saved.fsrsReviews.at(-1)?.evidence?.interveningWord, 'adopt');
    assert.equal(saved.fsrsReviews.at(-1)?.modelApplied, undefined);
  });
}

test('a caller cannot turn recent rehearsal into formal recall by supplying a fabricated intervening word', async () => {
  const { seed, answer } = setup();
  await seed('adapt');
  const first = await answer('adapt', 'first', 0);
  const saved = await answer('adapt', 'second', 10, 3,
    { kind: 'independent_recall', answerExposedAt: at(-120).toISOString(), interveningWord: 'invented-task' });
  assert.deepEqual(saved.fsrsReviews.at(-1)?.evidence,
    { kind: 'answer_rehearsal', answerExposedAt: at(0).toISOString() });
  assert.equal(saved.stability, first.stability);
});

test('practice classification stays frozen across retry, crash recovery and an explicit rating correction', async () => {
  const { storage, system, seed, answer } = setup();
  await seed('adapt');
  await seed('adopt');
  const first = await answer('adapt', 'first', 0);
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('isolated derived-state interruption'); };
  await assert.rejects(answer('adapt', 'practice', 10, 1), /interruption/);
  storage.saveMemoryState = save;
  const recovered = new MemorySystemV2(storage, undefined, 'UTC');
  await recovered.finalizeHistoricalDates(userId, 'UTC');
  const practiced = (await storage.getMemoryState(userId, 'adapt'))!;
  assert.equal(practiced.stability, first.stability);
  assert.equal(practiced.rme?.lastReviewGrade, first.rme?.lastReviewGrade);
  assert.equal(practiced.rme?.consecutiveAgain, first.rme?.consecutiveAgain);
  assert.equal(practiced.fsrsReviews.at(-1)?.modelApplied, false);
  await answer('adopt', 'other-word', 20);
  await answer('adapt', 'practice', 90, 1);
  let attempts = await system.getFlashcardReviewHistory(userId);
  assert.equal(attempts.find(row => row.attemptId === 'practice')?.occurredAt, at(10).toISOString());
  await system.correctFlashcardReview(userId, { correctionId: 'fix-practice', attemptId: 'practice',
    wordId: 'adapt', rating: 3, expectedRevision: 0 }, at(100));
  const corrected = (await storage.getMemoryState(userId, 'adapt'))!;
  assert.equal(corrected.stability, first.stability);
  assert.equal(corrected.fsrsCard.reps, 2);
  assert.equal(corrected.fsrsReviews.at(-1)?.modelApplied, false);
  attempts = await system.getFlashcardReviewHistory(userId);
  assert.equal(attempts.find(row => row.attemptId === 'practice')?.evidence?.kind, 'answer_rehearsal');
});

test('old policy word cards remain formal and do not acquire V6 evidence on replay', async () => {
  const { seed, answer, storage, system } = setup();
  await seed('adapt');
  const historicalPolicy = createFlashcardSchedulingPolicy(0.9, 5);
  await answer('adapt', 'old-first', 0, 3, undefined, historicalPolicy);
  await answer('adapt', 'old-second', 10, 3, undefined, historicalPolicy);
  const saved = (await storage.getMemoryState(userId, 'adapt'))!;
  assert.ok(saved.fsrsReviews.every(review => review.evidence === undefined && review.modelApplied === undefined));
  assert.ok((await readVerificationHistory(storage, userId)).every(row => row.purpose !== 'flashcard_review' || row.evidence === undefined));
  await system.finalizeHistoricalDates(userId, 'UTC');
  assert.deepEqual((await storage.getMemoryState(userId, 'adapt'))!.fsrsReviews, saved.fsrsReviews);
});

test('a device clock cannot go backwards into an already persisted practice attempt', async () => {
  const { seed, answer } = setup();
  await seed('adapt');
  await answer('adapt', 'first', 0);
  await answer('adapt', 'practice', 20);
  await assert.rejects(answer('adapt', 'backwards', 10), /设备时间/);
});
