import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createFlashcardSchedulingPolicy, continuousRecallIntervalMs } from '../src/lib/flashcardScheduling';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { calculateLongTermMemoryScore, calculateRetention, scoreToLevel } from '../src/lib/memoryV2/memoryScore';
import { buildWordMemoryDetails } from '../src/lib/wordMemoryDetails';
import { buildForgettingCurveModel } from '../src/lib/forgettingCurve';
import { importAndVerifyItem, parseMigrationItem } from '../src/lib/memoryV2/indexedDbImpl';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { projectWordProficiency } from '../src/lib/memoryV2/wordProficiency';
import type { FlashcardRecallEvidence, WordMemoryState } from '../src/lib/memoryV2/types';

const at = new Date('2026-10-24T04:00:00Z'), day = 86_400_000;
const policy = createFlashcardSchedulingPolicy(0.9, 6);
const preferences = { dailyNewWordLimit: 10, importedWordIds: ['adapt'] };
const practice: FlashcardRecallEvidence = { kind: 'answer_rehearsal', answerExposedAt: at.toISOString() };
function rate(state: WordMemoryState, rating: 1 | 3, seconds: number, evidence?: FlashcardRecallEvidence) {
  const next = submitFsrsReview(state, rating, new Date(at.getTime() + seconds * 1000), policy, evidence);
  Object.assign(next.fsrsReviews.at(-1)!, { source: 'flashcard', verificationAttemptIds: [`attempt:${seconds}`] });
  return next;
}

test('a failed start followed by three valid recalls gets the continuous model due before its next-day checkpoint', () => {
  let state = rate(initializeWordMemory('isolated-boundary', 'adapt'), 1, 0);
  for (let index = 1; index <= 3; index++) state = rate(state, 3, index);
  const interval = continuousRecallIntervalMs(state.stability, policy.desiredRetention);
  assert.ok(interval < day && interval > 6 * 60 * 60 * 1000);
  assert.ok(Math.abs(Date.parse(state.nextReview) - Date.parse(state.lastReview!) - interval) < 1);
  assert.ok(Math.abs(calculateRetention(interval / day, state.stability) - 0.9) < 1e-12);
  assert.equal(Date.parse(state.fsrsCard.confirmationDue!) - Date.parse(state.lastReview!), day);
});

test('the displayed cap preserves model stability beyond 180 days and L4 starts near 82 days', () => {
  const baseline = rate(initializeWordMemory('isolated-boundary', 'adapt'), 3, 0);
  assert.equal(scoreToLevel(calculateLongTermMemoryScore({ ...baseline, stability: 82 })), 4);
  for (const stability of [180, 360]) {
    const state = { ...baseline, stability, fsrsCard: { ...baseline.fsrsCard, stability, state: 2 } };
    assert.equal(calculateLongTermMemoryScore(state), 100);
    const updated = submitFsrsReview(state, 3, new Date(at.getTime() + 180 * day), policy);
    assert.ok(updated.stability > stability);
    assert.equal(state.stability, stability);
  }
});

test('answer rehearsal is visible separately and does not move the formal forgetting-curve origin', () => {
  const first = rate(initializeWordMemory('isolated-boundary', 'adapt'), 3, 0);
  const second = rate(first, 3, 5, practice), third = rate(second, 3, 10, practice);
  const details = buildWordMemoryDetails(third, preferences, new Date(at.getTime() + 15_000));
  assert.equal(details.reviewCount, 1);
  assert.equal(details.practiceCount, 2);
  assert.equal(details.lastReviewAt, at.toISOString());
  const curve = buildForgettingCurveModel([third], { now: new Date(at.getTime() + 15_000), currentWordId: 'adapt' });
  assert.equal(curve.personal.currentWord.lastRecallAt, at.toISOString());
  assert.equal(curve.personal.currentWord.reviewCount, 1);
});

test('unrated practice projects an active due schedule without a fabricated score or risk', () => {
  let state = initializeWordMemory('isolated-boundary', 'adapt');
  for (let index = 0; index < 3; index++) state = rate(state, 3, index, practice);
  const view = projectWordProficiency(state, preferences, at);
  assert.equal(view.hasPractice, true);
  assert.equal(view.memoryScore, 0);
  assert.equal(view.forgettingRiskPercent, undefined);
  assert.equal(view.studyStatus, 'learning');
  assert.ok(Date.parse(view.nextReview) > at.getTime());
  const due = projectWordProficiency(state, preferences, new Date(at.getTime() + 2 * day));
  assert.equal(due.studyStatus, 'due');
  const details = buildWordMemoryDetails(state, preferences, at);
  assert.equal(details.reviewCount, 0);
  assert.equal(details.practiceCount, 3);
  assert.equal(details.score, null);
  assert.equal(details.nextReviewAt, view.nextReview);
});

class BrowserStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
test('merging separate practice branches replays evidence without converting either rehearsal into a model update', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new BrowserStorage() } });
  const storage = new LocalStorageMemoryStorage();
  const first = rate(initializeWordMemory('isolated-boundary', 'adapt'), 3, 0);
  const left = rate(first, 3, 5, practice), right = rate(first, 3, 10, practice);
  const key = 'english-ai:v2:memory:state:isolated-boundary:adapt';
  await importAndVerifyItem(storage, parseMigrationItem(key, left)!);
  await importAndVerifyItem(storage, parseMigrationItem(key, right)!);
  const merged = (await storage.getMemoryState('isolated-boundary', 'adapt'))!;
  assert.equal(merged.stability, first.stability);
  assert.equal(merged.lastReview, first.lastReview);
  assert.equal(merged.fsrsReviews.filter(row => row.modelApplied === false).length, 2);
  assert.equal(merged.fsrsReviews.filter(row => row.modelApplied !== false).length, 1);
  const conflict = structuredClone(right);
  conflict.fsrsReviews.at(-1)!.evidence = { kind: 'independent_recall' };
  await assert.rejects(importAndVerifyItem(storage, parseMigrationItem(key, conflict)!), /Conflicting flashcard recall evidence/);
  assert.deepEqual(await storage.getMemoryState('isolated-boundary', 'adapt'), merged);
});
