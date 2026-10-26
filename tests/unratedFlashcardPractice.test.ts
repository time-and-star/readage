import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { State } from 'ts-fsrs';
import { continuousRecallIntervalMs, createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { projectUnratedFlashcardPractice } from '../src/lib/flashcardPractice';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { hasFormalRecallEvidence } from '../src/lib/memoryV2/rmeV4Bridge';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import type { FlashcardReviewInput, WordMemoryState } from '../src/lib/memoryV2/types';

const policy = createFlashcardSchedulingPolicy(0.9, 6);
const start = Date.parse('2026-10-23T08:00:00.000Z');
const at = (seconds: number) => new Date(start + seconds * 1_000);
const exposure = { kind: 'answer_rehearsal' as const, answerExposedAt: at(0).toISOString() };
function practice(state: WordMemoryState, seconds: number, rating: 1 | 2 | 3 = 3) {
  const saved = submitFsrsReview(state, rating, at(seconds), policy, exposure);
  Object.assign(saved.fsrsReviews.at(-1)!, { source: 'flashcard', verificationAttemptIds: [`practice:${seconds}`] });
  return saved;
}
class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
function setup() {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  const system = new MemorySystemV2(storage, undefined, 'UTC');
  const seed = async (wordId = 'adapt', lastAssistedAt = at(0).toISOString()) => {
    await storage.saveMemoryState({ ...initializeWordMemory('isolated-unrated', wordId), lastAssistedAt });
  };
  const answer = async (attemptId: string, seconds: number, rating: 1 | 2 | 3 = 3, wordId = 'adapt') => {
    const state = (await storage.getMemoryState('isolated-unrated', wordId))!;
    const input: FlashcardReviewInput = { attemptId, questionId: wordId, wordId, articleId: 'cards',
      purpose: 'flashcard_review', rating, outcome: rating === 1 ? 'incorrect' : rating === 2 ? 'uncertain' : 'recognized',
      scheduling: policy, expectedReps: state.fsrsCard.reps };
    await system.recordVerification('isolated-unrated', input, at(seconds));
    return (await storage.getMemoryState('isolated-unrated', wordId))!;
  };
  return { storage, system, seed, answer };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

test('unrated practice preserves a New memory card and derives all three product steps from logs', () => {
  const initial = initializeWordMemory('u', 'adapt');
  const first = practice(initial, 0);
  const second = practice(first, 10);
  const third = practice(second, 20);
  assert.equal(third.stability, 0);
  assert.equal(third.difficulty, 0);
  assert.equal(third.lastReview, null);
  assert.equal(third.fsrsCard.state, State.New);
  assert.equal(third.fsrsCard.lastReview, undefined);
  assert.equal(third.fsrsCard.learningSteps, 0);
  assert.equal(third.fsrsCard.reps, 3, 'reps is the existing optimistic attempt version');
  assert.equal(third.fsrsCard.due, initial.fsrsCard.due);
  assert.equal(third.nextReview, initial.nextReview);
  assert.equal(hasFormalRecallEvidence(third), false);
  assert.deepEqual(projectUnratedFlashcardPractice(third), { steps: 3, phase: 'confirmation',
    due: at(86_420).toISOString(), lastAnswerAt: at(20).toISOString(), attemptCount: 3,
    confirmationDue: at(86_420).toISOString() });
});

test('Hard preserves unrated progress, failure resets it, and duplicate imported attempts do not add steps', () => {
  const first = practice(initializeWordMemory('u', 'adapt'), 0);
  const hard = practice(first, 10, 2);
  assert.equal(projectUnratedFlashcardPractice(hard)?.steps, 1);
  const failed = practice(hard, 20, 1);
  assert.equal(failed.stability, 0);
  assert.equal(projectUnratedFlashcardPractice(failed)?.steps, 0);
  const duplicate = { ...first, fsrsReviews: [...first.fsrsReviews, ...first.fsrsReviews] };
  assert.equal(projectUnratedFlashcardPractice(duplicate)?.steps, 1);
  assert.equal(projectUnratedFlashcardPractice(duplicate)?.attemptCount, 1);
});

test('a first independent recall inherits prior practice steps and coordinates the remaining checkpoint', () => {
  const second = practice(practice(initializeWordMemory('u', 'adapt'), 0), 10);
  const hard = submitFsrsReview(second, 2, at(70), policy, { kind: 'independent_recall' });
  assert.ok(hard.stability > 0);
  assert.equal(hard.fsrsCard.learningSteps, 2);
  const recognized = submitFsrsReview(second, 3, at(70), policy, { kind: 'independent_recall' });
  assert.equal(recognized.fsrsCard.state, State.Review);
  assert.equal(recognized.fsrsCard.confirmationDue, at(86_470).toISOString());
  assert.equal(recognized.nextReview, at(86_470).toISOString());
  assert.equal(recognized.fsrsReviews.filter(row => row.modelApplied !== false).length, 1);
});

test('a delayed independent confirmation initializes FSRS once and graduates without another three rounds', () => {
  const completed = practice(practice(practice(initializeWordMemory('u', 'adapt'), 0), 10), 20);
  const confirmation = at(86_420);
  const saved = submitFsrsReview(completed, 3, confirmation, policy, { kind: 'independent_recall' });
  assert.equal(saved.fsrsCard.state, State.Review);
  assert.equal(saved.fsrsCard.learningSteps, 0);
  assert.equal(saved.fsrsCard.confirmationDue, undefined);
  assert.equal(saved.lastReview, confirmation.toISOString());
  assert.equal(saved.fsrsReviews.filter(row => row.modelApplied !== false).length, 1);
  assert.equal(saved.nextReview, new Date(confirmation.getTime() + continuousRecallIntervalMs(saved.stability, 0.9)).toISOString());
  assert.equal(projectUnratedFlashcardPractice(saved), null);
  const failed = submitFsrsReview(completed, 1, confirmation, policy, { kind: 'independent_recall' });
  assert.equal(failed.fsrsCard.state, State.Learning);
  assert.equal(failed.fsrsCard.learningSteps, 0);
  assert.ok(failed.stability > 0);
});

test('a recent first lookup produces practice, persists three steps, and blocks an early fourth submission', async () => {
  const { storage, system, seed, answer } = setup();
  await seed();
  await answer('first', 0);
  await answer('second', 10);
  const third = await answer('third', 20);
  assert.equal(third.stability, 0);
  assert.equal(third.lastReview, null);
  assert.ok(third.fsrsReviews.every(row => row.modelApplied === false));
  const due = projectUnratedFlashcardPractice(third)!.due;
  await assert.rejects(answer('early-fourth', 90), /尚未到期/);
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.finalizeHistoricalDates('isolated-unrated', 'UTC');
  const restored = (await storage.getMemoryState('isolated-unrated', 'adapt'))!;
  assert.equal(projectUnratedFlashcardPractice(restored)?.due, due);
  const saved = await answer('delayed-confirmation', 86_420);
  assert.equal(saved.fsrsCard.state, State.Review);
  assert.equal(saved.fsrsReviews.filter(row => row.modelApplied !== false).length, 1);
  assert.equal((await system.getFlashcardReviewHistory('isolated-unrated')).length, 4);
});

test('a persisted task for another word can separate the first lookup from an independent recall', async () => {
  const { seed, answer } = setup();
  await seed();
  await seed('adopt', at(-86_400).toISOString());
  await answer('other-word', 5, 3, 'adopt');
  const saved = await answer('first-adapt', 10);
  assert.ok(saved.stability > 0);
  assert.equal(saved.fsrsReviews[0].evidence?.kind, 'independent_recall');
  assert.equal(saved.fsrsReviews[0].evidence?.interveningWord, 'adopt');
});

test('unrated rating corrections replay product steps while keeping the formal model empty', async () => {
  const { system, storage, seed, answer } = setup();
  await seed();
  await answer('first', 0);
  await answer('second', 10);
  await answer('third', 20);
  await system.correctFlashcardReview('isolated-unrated', { correctionId: 'correct-first', attemptId: 'first',
    wordId: 'adapt', rating: 1, expectedRevision: 0 }, at(30));
  const saved = (await storage.getMemoryState('isolated-unrated', 'adapt'))!;
  assert.equal(saved.stability, 0);
  assert.equal(saved.lastReview, null);
  assert.equal(saved.fsrsCard.reps, 3);
  assert.equal(projectUnratedFlashcardPractice(saved)?.steps, 2);
  assert.equal(projectUnratedFlashcardPractice(saved)?.confirmationDue, undefined);
});
