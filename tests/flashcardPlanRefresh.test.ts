import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { buildFlashcardQueue, submitFlashcardRating } from '../src/lib/flashcardReview';
import { getFlashcardPlanSettingsKey, reconcileFlashcardSession, shouldRefreshFlashcardSession } from '../src/lib/flashcardSessionSettings';
import type { FlashcardQueueCard } from '../src/lib/flashcardReview';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const at = new Date('2026-10-07T12:00:00.000Z');
const stores: MemoryV2Store[] = [];
function setup() {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  const store = new MemoryV2Store({ storage: new LocalStorageMemoryStorage(), userId: 'u', timezone: 'UTC', now: () => at });
  stores.push(store);
  return store;
}
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  Reflect.deleteProperty(globalThis, 'window');
});
async function loadPlan(store: MemoryV2Store, now = at) {
  const [states, preferences] = await Promise.all([
    store.system.getReadingVerificationMemoryStates(store.userId),
    store.system.getFlashcardStudyPreferences(store.userId),
  ]);
  return { preferences, key: getFlashcardPlanSettingsKey(preferences),
    plan: buildFlashcardQueue(states, { now, timezone: store.timezone, newWordLimit: preferences.dailyNewWordLimit,
      enrolledWordIds: new Set(preferences.importedWordIds), pausedWordIds: new Set(preferences.pausedWordIds),
      excludedWordIds: new Set(preferences.excludedWordIds) }) };
}

test('saving unlimited publishes a version and immediately reopens a quota-exhausted session from durable words', async () => {
  const store = setup();
  await store.importFlashcardWords(['apple', 'banana', 'cherry']);
  await store.saveFlashcardStudyPreferences(1);
  const initial = await loadPlan(store);
  assert.deepEqual(initial.plan.cards.map(card => card.wordId), ['apple']);
  await submitFlashcardRating(store, { attemptId: 'first-apple', wordId: 'apple', rating: 'good' });
  const exhausted = await loadPlan(store);
  assert.equal(exhausted.plan.cards.length, 0);
  assert.equal(exhausted.plan.remainingNewCount, 2);
  assert.equal(exhausted.plan.newIntroducedToday, 1);
  let session: FlashcardQueueCard[] = [];
  let appliedKey = exhausted.key;
  const beforeVersion = store.getSnapshot().version;
  const notified: number[] = [];
  const unsubscribe = store.subscribe(() => notified.push(store.getSnapshot().version));

  await store.saveFlashcardStudyPreferences(null);
  assert.ok(store.getSnapshot().version > beforeVersion);
  assert.ok(notified.some(version => version > beforeVersion));
  const unlimited = await loadPlan(store);
  assert.equal(unlimited.preferences.dailyNewWordLimit, null);
  assert.ok(shouldRefreshFlashcardSession(session, appliedKey, unlimited.key));
  session = reconcileFlashcardSession(session, unlimited.plan.cards, new Set(), false);
  appliedKey = unlimited.key;
  assert.deepEqual(session.map(card => card.wordId), ['banana', 'cherry']);
  assert.equal(unlimited.plan.newCount, 2);
  assert.equal(shouldRefreshFlashcardSession(session, appliedKey, unlimited.key), false);
  unsubscribe();
});

test('review-only settings remove fresh cards but preserve the saved answer and later due reviews', async () => {
  const store = setup();
  await store.importFlashcardWords(['apple', 'banana']);
  await store.saveFlashcardStudyPreferences(null);
  const initial = await loadPlan(store);
  const saved = initial.plan.cards[0];
  const result = await submitFlashcardRating(store, { attemptId: 'first-apple', wordId: 'apple', rating: 'good' });
  const afterReview = await loadPlan(store);
  assert.equal(shouldRefreshFlashcardSession(initial.plan.cards, initial.key, afterReview.key), false,
    'an ordinary saved rating must not replace the answer the learner is reading');

  await store.saveFlashcardStudyPreferences(0);
  const reviewOnly = await loadPlan(store);
  assert.ok(shouldRefreshFlashcardSession(initial.plan.cards, initial.key, reviewOnly.key));
  assert.equal(reviewOnly.plan.remainingNewCount, 1);
  assert.equal(reviewOnly.plan.newCount, 0);
  assert.deepEqual(reconcileFlashcardSession(initial.plan.cards, reviewOnly.plan.cards, new Set(), true), [saved]);
  assert.deepEqual(reconcileFlashcardSession(initial.plan.cards.slice(1), reviewOnly.plan.cards, new Set(), false), []);

  const due = await loadPlan(store, new Date(result.nextReview));
  assert.equal(due.preferences.dailyNewWordLimit, 0);
  assert.equal(due.plan.dueCount, 1);
  assert.ok(shouldRefreshFlashcardSession([], reviewOnly.key, due.key));
  assert.deepEqual(reconcileFlashcardSession([], due.plan.cards, new Set(), false).map(card => card.wordId), ['apple']);
});

test('unlimited cannot create new cards after the enrolled pool is introduced, and paused or skipped cards stay out', async () => {
  const store = setup();
  await store.importFlashcardWords(['apple', 'banana']);
  await store.saveFlashcardStudyPreferences(null);
  const initial = await loadPlan(store);
  await store.updateFlashcardWords(['banana'], 'pause');
  const paused = await loadPlan(store);
  assert.ok(shouldRefreshFlashcardSession(initial.plan.cards, initial.key, paused.key));
  assert.deepEqual(paused.plan.cards.map(card => card.wordId), ['apple']);
  assert.deepEqual(reconcileFlashcardSession([], paused.plan.cards, new Set(['apple']), false), []);
  await submitFlashcardRating(store, { attemptId: 'first-apple', wordId: 'apple', rating: 'good' });
  const complete = await loadPlan(store);
  assert.equal(complete.plan.dueCount, 0);
  assert.equal(complete.plan.remainingNewCount, 0);
  assert.equal(complete.plan.newCount, 0);
  assert.ok(complete.plan.nextDueAt);
  assert.deepEqual(complete.plan.cards, []);
});

test('settings identity ignores set ordering but distinguishes unlimited from review-only', () => {
  const base = { dailyNewWordLimit: null, importedWordIds: ['banana', 'apple', 'apple'], pausedWordIds: ['paused'] };
  assert.equal(getFlashcardPlanSettingsKey(base), getFlashcardPlanSettingsKey({ ...base, importedWordIds: ['apple', 'banana'], excludedWordIds: [] }));
  assert.notEqual(getFlashcardPlanSettingsKey(base), getFlashcardPlanSettingsKey({ ...base, dailyNewWordLimit: 0 }));
});
