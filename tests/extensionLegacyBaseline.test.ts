import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { hasFormalRecallEvidence } from '../src/lib/memoryV2/rmeV4Bridge';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { importLookupEvents, readExternalLearningActivity } from '../src/lib/browserExtension/importer';
import type { LookupEvent } from '../src/lib/browserExtension/protocol';

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
  return { storage, system: new MemorySystemV2(storage, undefined, 'UTC') };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });
const reviewedAt = new Date('2026-01-05T12:00:00.000Z');
const now = new Date('2026-01-12T12:00:00.000Z');
const legacyBaseline = () => {
  const state = submitFsrsReview(initializeWordMemory('u', 'resilient'), 3, reviewedAt);
  state.fsrsReviews = [];
  return state;
};
const lookup = (day: string, id: string): LookupEvent => ({ version: 1, id, query: 'resilient', lemma: 'resilient',
  occurredAt: `${day}T12:00:00.000Z`, timezone: 'UTC', sourceId: `web:${'a'.repeat(64)}` });

test('extension import preserves a formal legacy card with no reconstructable review logs', async () => {
  const { storage, system } = setup();
  const baseline = legacyBaseline();
  await storage.saveMemoryState(baseline);
  const event = lookup('2026-01-07', '10000000-0000-4000-8000-000000000001');
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const saved = (await storage.getMemoryState('u', 'resilient'))!;
  const expected = submitFsrsReview(baseline, 1, new Date(event.occurredAt));
  assert.deepEqual(saved.fsrsCard, JSON.parse(JSON.stringify(expected.fsrsCard)));
  assert.equal(saved.fsrsCard.reps, 2);
  assert.equal(saved.fsrsReviews.length, 1);
  assert.equal(saved.fsrsReviews[0].source, 'reading_lookup');
  assert.equal(hasFormalRecallEvidence(saved), true);
  assert.equal((await system.getWordProficiency('u', 'resilient', now))!.isIntroduced, false);
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), saved);
});

test('extension replay restores the hidden pre-log card before replaying an existing lookup tail', async () => {
  const { storage } = setup();
  const baseline = submitFsrsReview(legacyBaseline(), 1, new Date('2026-01-07T12:00:00.000Z'));
  baseline.fsrsReviews[0].source = 'reading_lookup';
  baseline.fsrsReviews[0].localDate = '2026-01-07';
  await storage.saveMemoryState(baseline);
  const event = lookup('2026-01-09', '10000000-0000-4000-8000-000000000002');
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const saved = (await storage.getMemoryState('u', 'resilient'))!;
  const expected = submitFsrsReview(baseline, 1, new Date(event.occurredAt));
  assert.deepEqual(saved.fsrsCard, JSON.parse(JSON.stringify(expected.fsrsCard)));
  assert.equal(saved.fsrsCard.reps, 3);
  assert.equal(saved.fsrsCard.lapses, 2);
  assert.equal(saved.fsrsReviews.length, 2);
  assert.equal(hasFormalRecallEvidence(saved), true);
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), saved);
});

test('a lookup preceding the unlogged review boundary remains history without rewinding the known card', async () => {
  const { storage } = setup();
  const baseline = legacyBaseline();
  await storage.saveMemoryState(baseline);
  const event = lookup('2026-01-03', '10000000-0000-4000-8000-000000000003');
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const saved = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(saved.fsrsCard, JSON.parse(JSON.stringify(baseline.fsrsCard)));
  assert.equal(saved.lastReview, baseline.lastReview);
  assert.equal(saved.fsrsCard.reps, 1);
  assert.equal(saved.fsrsReviews.length, 0);
  assert.equal(hasFormalRecallEvidence(saved), true);
  assert.equal((await readExternalLearningActivity(storage, 'u')).length, 1);
  assert.equal((await storage.getDailyEvidence('u', 'resilient', '2026-01-03'))!.clickedOccurrenceCount, 1);
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), saved);
});

test('later word-card correction and extension retries retain the legacy baseline and one audited recall', async () => {
  const { storage, system } = setup();
  await storage.saveMemoryState(legacyBaseline());
  const event = lookup('2026-01-07', '10000000-0000-4000-8000-000000000004');
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const recallAt = new Date('2026-01-09T12:00:00.000Z');
  await system.recordVerification('u', { attemptId: 'legacy-card', questionId: 'q-legacy', wordId: 'resilient',
    articleId: 'cards', purpose: 'flashcard_review', rating: 3, outcome: 'recognized' }, recallAt);
  await system.correctFlashcardReview('u', { correctionId: 'legacy-correction', attemptId: 'legacy-card',
    wordId: 'resilient', rating: 1, expectedRevision: 0 }, new Date(recallAt.getTime() + 60_000));
  const corrected = (await storage.getMemoryState('u', 'resilient'))!;
  assert.equal(corrected.fsrsCard.reps, 3);
  assert.equal(corrected.fsrsReviews.length, 2);
  const review = corrected.fsrsReviews.find(row => row.source === 'flashcard')!;
  assert.equal(review.rating, 1);
  assert.equal(review.review, recallAt.toISOString());
  assert.equal(review.originalFlashcardRating, 3);
  assert.equal(review.flashcardRevisions?.length, 1);
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const replayed = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(replayed.fsrsCard, corrected.fsrsCard);
  assert.deepEqual(replayed.fsrsReviews, corrected.fsrsReviews);
  assert.equal(hasFormalRecallEvidence(replayed), true);
});
