import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { buildFlashcardQueue, correctFlashcardRating, previewFlashcardIntervals, submitFlashcardRating } from '../src/lib/flashcardReview';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { readVerificationHistory } from '../src/lib/memoryV2/verificationMemory';
import { appendJournalEvents } from '../src/lib/browserExtension/importer';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const originalAt = new Date('2026-09-06T12:00:00.000Z');
const stores: MemoryV2Store[] = [];
function setup() {
  const browser = new BrowserStorage();
  Object.defineProperty(globalThis, 'window', { value: { localStorage: browser }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  let clock = originalAt;
  const store = new MemoryV2Store({ storage, userId: 'u', timezone: 'UTC', now: () => clock });
  stores.push(store);
  return { storage, store, setNow: (now: Date) => { clock = now; } };
}
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  Reflect.deleteProperty(globalThis, 'window');
});
function fresh(wordId = 'resilient'): WordMemoryState {
  const state = initializeWordMemory('u', wordId);
  state.nextReview = originalAt.toISOString();
  state.fsrsCard.due = state.nextReview;
  state.lastAssistedAt = '2026-09-05T10:00:00.000Z';
  return state;
}
const original = { attemptId: 'first-recall', wordId: 'resilient', rating: 'good' as const };
const correction = { correctionId: 'first-correction', attemptId: original.attemptId,
  wordId: original.wordId, rating: 'again' as const, expectedRevision: 0 };

test('a correction replaces one rating at its original recall time and retains an audit trail', async () => {
  const { storage, store, setNow } = setup();
  const before = fresh();
  await storage.saveMemoryState(before);
  const preview = previewFlashcardIntervals(before, originalAt).again;
  const first = await submitFlashcardRating(store, original);
  const correctedAt = new Date('2026-09-06T12:02:00.000Z');
  setNow(correctedAt);
  const saved = await correctFlashcardRating(store, correction);
  assert.equal(saved.fsrsCard.reps, first.fsrsCard.reps);
  assert.equal(saved.fsrsReviews.length, 1);
  assert.equal(saved.fsrsReviews[0].rating, 1);
  assert.equal(saved.lastReview, originalAt.toISOString());
  assert.equal(saved.fsrsCard.lastReview, originalAt.toISOString());
  assert.equal(saved.nextReview, preview.nextReview);
  const [attempt] = await readVerificationHistory(storage, 'u');
  assert.equal(attempt.occurredAt, originalAt.toISOString());
  assert.equal(attempt.localDate, '2026-09-06');
  assert.equal(attempt.originalFlashcardRating, 3);
  assert.equal(attempt.outcome, 'incorrect');
  assert.deepEqual(attempt.flashcardRevisions, [{ correctionId: correction.correctionId,
    revision: 1, previousRating: 3, rating: 1, correctedAt: correctedAt.toISOString() }]);
  assert.deepEqual(saved.fsrsReviews[0].flashcardRevisions, attempt.flashcardRevisions);
  assert.equal(saved.fsrsReviews[0].originalFlashcardRating, 3);
});

test('correction retries and delayed original submissions preserve the latest corrected rating', async () => {
  const { storage, store, setNow } = setup();
  await storage.saveMemoryState(fresh());
  await submitFlashcardRating(store, original);
  const first = await correctFlashcardRating(store, correction);
  setNow(new Date('2026-09-06T12:02:00.000Z'));
  const retry = await correctFlashcardRating(store, correction);
  assert.deepEqual(retry.fsrsCard, first.fsrsCard);
  assert.deepEqual(retry.fsrsReviews, first.fsrsReviews);
  const second = await correctFlashcardRating(store, { ...correction, correctionId: 'second-correction',
    rating: 'hard', expectedRevision: 1 });
  const delayedCorrection = await correctFlashcardRating(store, correction);
  const delayedOriginal = await submitFlashcardRating(store, original);
  assert.equal(second.fsrsCard.reps, 1);
  assert.deepEqual(delayedCorrection.fsrsReviews, second.fsrsReviews);
  assert.deepEqual(delayedOriginal.fsrsReviews, second.fsrsReviews);
  assert.equal(second.fsrsReviews[0].rating, 2);
  assert.equal((await readVerificationHistory(storage, 'u')).length, 1);
  assert.equal((await readVerificationHistory(storage, 'u'))[0].flashcardRevisions?.length, 2);
});

test('stale revisions and conflicting correction identities cannot overwrite a saved correction', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(fresh());
  await submitFlashcardRating(store, original);
  const corrected = await correctFlashcardRating(store, correction);
  await assert.rejects(correctFlashcardRating(store, { ...correction, correctionId: 'stale-tab', rating: 'easy' }), /其他页面修改/);
  await assert.rejects(correctFlashcardRating(store, { ...correction, rating: 'hard' }), /标识冲突/);
  await assert.rejects(correctFlashcardRating(store, { ...correction, expectedRevision: 1 }), /标识冲突/);
  assert.deepEqual((await storage.getMemoryState('u', original.wordId))!.fsrsReviews, corrected.fsrsReviews);
  assert.equal((await readVerificationHistory(storage, 'u'))[0].flashcardRevisions?.length, 1);
});

test('concurrent retries commit one revision and concurrent competing corrections require a fresh revision', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(fresh());
  await submitFlashcardRating(store, original);
  const [first, retry] = await Promise.all([correctFlashcardRating(store, correction), correctFlashcardRating(store, correction)]);
  assert.deepEqual(retry.fsrsReviews, first.fsrsReviews);
  assert.equal(first.fsrsReviews[0].flashcardRevisions?.length, 1);
  const competing = await Promise.allSettled([
    correctFlashcardRating(store, { ...correction, correctionId: 'tab-a', rating: 'hard', expectedRevision: 1 }),
    correctFlashcardRating(store, { ...correction, correctionId: 'tab-b', rating: 'easy', expectedRevision: 1 }),
  ]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  const failure = competing.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(failure.reason.message, /其他页面修改/);
  const saved = (await storage.getMemoryState('u', original.wordId))!;
  assert.equal(saved.fsrsCard.reps, 1);
  assert.equal(saved.fsrsReviews[0].flashcardRevisions?.length, 2);
  assert.deepEqual((await submitFlashcardRating(store, original)).fsrsReviews, saved.fsrsReviews);
});

test('a failed correction journal write preserves both the original grade and schedule until a successful retry', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(fresh());
  const first = await submitFlashcardRating(store, original);
  const priorJournal = await readVerificationHistory(storage, 'u');
  const write = storage.setMeta!.bind(storage);
  storage.setMeta = async () => { const error = new Error('quota exceeded'); error.name = 'QuotaExceededError'; throw error; };
  await assert.rejects(correctFlashcardRating(store, correction), /quota/);
  assert.deepEqual(await readVerificationHistory(storage, 'u'), priorJournal);
  assert.deepEqual((await storage.getMemoryState('u', original.wordId))!.fsrsCard, first.fsrsCard);
  assert.match(store.getSnapshot().storageError!, /修改尚未完成/);
  storage.setMeta = write;
  const saved = await correctFlashcardRating(store, correction);
  assert.equal(saved.fsrsReviews[0].rating, 1);
  assert.equal(saved.fsrsCard.reps, first.fsrsCard.reps);
  assert.equal(store.getSnapshot().storageError, null);
});

test('an interrupted derived correction is not reported as success and retries repair only the same recall', async () => {
  const { storage, store, setNow } = setup();
  await storage.saveMemoryState(fresh());
  const first = await submitFlashcardRating(store, original);
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('interrupted corrected card write'); };
  await assert.rejects(correctFlashcardRating(store, correction), /interrupted/);
  assert.equal((await readVerificationHistory(storage, 'u'))[0].flashcardRevisions?.length, 1);
  assert.equal((await storage.getMemoryState('u', original.wordId))!.fsrsReviews[0].rating, 3);
  storage.saveMemoryState = save;
  setNow(new Date('2026-09-06T12:03:00.000Z'));
  const repaired = await correctFlashcardRating(store, correction);
  assert.equal(repaired.fsrsCard.reps, first.fsrsCard.reps);
  assert.equal(repaired.lastReview, originalAt.toISOString());
  assert.equal(repaired.fsrsReviews[0].rating, 1);
  assert.equal(repaired.fsrsReviews[0].flashcardRevisions?.length, 1);
  assert.equal(repaired.fsrsReviews[0].flashcardRevisions?.[0].correctedAt, originalAt.toISOString());
});

test('reopening repairs a durable correction before using its schedule', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(fresh());
  await submitFlashcardRating(store, original);
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('crash'); };
  await assert.rejects(correctFlashcardRating(store, correction), /crash/);
  storage.saveMemoryState = save;
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.finalizeHistoricalDates('u', 'UTC');
  const recovered = (await storage.getMemoryState('u', original.wordId))!;
  assert.equal(recovered.fsrsReviews[0].rating, 1);
  assert.equal(recovered.fsrsCard.reps, 1);
  assert.equal(recovered.lastReview, originalAt.toISOString());
  assert.equal(recovered.fsrsReviews[0].flashcardRevisions?.length, 1);
});

test('correcting an older recall replays later reviews at their original times without extra repetitions', async () => {
  const { storage, store, setNow } = setup();
  const baseline = fresh();
  await storage.saveMemoryState(baseline);
  await submitFlashcardRating(store, original);
  const laterAt = new Date('2026-09-16T12:00:00.000Z');
  setNow(laterAt);
  await submitFlashcardRating(store, { ...original, attemptId: 'second-recall', rating: 'easy' });
  setNow(new Date('2026-09-16T12:05:00.000Z'));
  const corrected = await correctFlashcardRating(store, correction);
  const expected = submitFsrsReview(submitFsrsReview(baseline, 1, originalAt), 4, laterAt);
  assert.deepEqual(corrected.fsrsCard, expected.fsrsCard);
  assert.equal(corrected.fsrsCard.reps, 2);
  assert.deepEqual(corrected.fsrsReviews.map(review => [review.rating, review.review]), [[1, originalAt.toISOString()], [4, laterAt.toISOString()]]);
  assert.equal(corrected.fsrsReviews[0].flashcardRevisions?.length, 1);
  assert.equal(corrected.fsrsReviews[1].flashcardRevisions, undefined);
});

test('extension lookup replay retains the corrected recall and its audit independently of daily lookup failures', async () => {
  const { storage, store, setNow } = setup();
  await storage.saveMemoryState(fresh());
  await submitFlashcardRating(store, original);
  const row = { userId: 'u', wordId: original.wordId, articleId: 'external', occurrenceId: 'extension:one',
    eventType: 'exposure' as const, occurredAt: '2026-09-06T14:00:00.000Z', localDate: '2026-09-06' };
  const events = [row, { ...row, eventType: 'click' as const }];
  const later = new Date('2026-09-07T12:00:00.000Z');
  await appendJournalEvents(storage, events, 'UTC', later, true);
  const before = (await storage.getMemoryState('u', original.wordId))!;
  setNow(later);
  const corrected = await correctFlashcardRating(store, correction);
  assert.equal(corrected.fsrsCard.reps, before.fsrsCard.reps);
  assert.deepEqual(corrected.fsrsReviews.map(review => [review.source, review.rating]), [['flashcard', 1], ['reading_lookup', 1]]);
  assert.equal(corrected.fsrsReviews[0].flashcardRevisions?.length, 1);
  await appendJournalEvents(storage, events, 'UTC', later, true);
  assert.deepEqual((await storage.getMemoryState('u', original.wordId))!.fsrsReviews, corrected.fsrsReviews);
  const oldRetry = await submitFlashcardRating(store, original);
  assert.deepEqual(oldRetry.fsrsReviews, corrected.fsrsReviews);
});

test('a backdated correction or a correction without a saved recall is rejected before writing an audit', async () => {
  const { storage, store, setNow } = setup();
  await storage.saveMemoryState(fresh());
  await assert.rejects(correctFlashcardRating(store, correction), /找不到本次/);
  await submitFlashcardRating(store, original);
  setNow(new Date('2026-09-06T11:59:00.000Z'));
  await assert.rejects(correctFlashcardRating(store, correction), /设备时间/);
  assert.equal((await readVerificationHistory(storage, 'u'))[0].flashcardRevisions, undefined);
});

test('a partial imported recall baseline is an existing due word independent of the daily new-word budget', async () => {
  const { storage, store } = setup();
  const state = submitFsrsReview(fresh(), 1, new Date('2026-09-05T12:00:00.000Z'));
  state.fsrsReviews[0].source = 'reading_lookup';
  state.fsrsCard.reps = 2; // One legacy recall predates the retained lookup log.
  state.nextReview = '2026-09-07T12:00:00.000Z';
  state.fsrsCard.due = state.nextReview;
  assert.equal(buildFlashcardQueue([state], { now: originalAt, timezone: 'UTC', newWordLimit: 0 }).cards.length, 0);
  await storage.saveMemoryState(state);
  await assert.rejects(submitFlashcardRating(store, { ...original, attemptId: 'too-early' }), /尚未到期/);
  assert.equal((await readVerificationHistory(storage, 'u')).length, 0);
  state.nextReview = originalAt.toISOString();
  state.fsrsCard.due = state.nextReview;
  const due = buildFlashcardQueue([state], { now: originalAt, timezone: 'UTC', newWordLimit: 0 });
  assert.equal(due.cards.length, 1);
  assert.equal(due.cards[0].kind, 'due');
  assert.equal(due.newCount, 0);
});
