import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { calculateFsrsForgettingCurve } from '../src/lib/fsrs';
import { hasFormalRecallEvidence } from '../src/lib/memoryV2/rmeV4Bridge';
import { buildAfterReadingContext } from '../src/lib/afterReadingContext';
import { createEmptyRmeProfile } from '../src/lib/memoryV4';
import type { ReadingVerificationInput, WordMemoryState } from '../src/lib/memoryV2/types';

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
  const browser = new BrowserStorage();
  Object.defineProperty(globalThis, 'window', { value: { localStorage: browser }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  return { storage, system: new MemorySystemV2(storage, undefined, 'UTC') };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });
const start = new Date('2026-01-01T12:00:00.000Z');
const DAY = 86_400_000;
const card = (attemptId: string, wordId = 'resilient', rating = 3 as 1 | 2 | 3 | 4) => ({
  attemptId, questionId: `q-${attemptId}`, wordId, articleId: 'flashcards',
  outcome: rating === 1 ? 'incorrect' as const : rating === 2 ? 'uncertain' as const : 'recognized' as const,
  purpose: 'flashcard_review' as const, rating,
});
const counters = (state: WordMemoryState) => ({
  success: state.rme?.successfulExposureCount, failure: state.rme?.failedExposureCount,
  exposures: state.rme?.exposureHistory.length,
});
const teacherWord = (state: WordMemoryState, now: Date) => buildAfterReadingContext({
  states: [state], history: [], candidates: [], articleText: state.wordId, articleId: 'article',
  canonicalWordIds: new Map(), now,
}).learnerWords.find(word => word.wordId === state.wordId)!;

test('imported word-card recalls predict recall without passive exposure and stay consistent after retries and reload', async () => {
  const { storage, system } = setup();
  await system.importFlashcardWords('u', ['resilient'], undefined, start);
  let at = start;
  for (let index = 0; index < 4; index += 1) {
    const input = card(`card-${index}`);
    await system.recordVerification('u', input, at);
    const saved = (await storage.getMemoryState('u', 'resilient'))!;
    await system.recordVerification('u', input, new Date(at.getTime() + 60_000));
    assert.deepEqual(await storage.getMemoryState('u', 'resilient'), saved);
    const view = (await system.getWordProficiency('u', 'resilient', at))!;
    assert.equal(view.confidence, 100);
    assert.equal(saved.fsrsCard.reps, index + 1);
    assert.deepEqual(counters(saved), { success: 0, failure: 0, exposures: 0 });
    if (index === 3) {
      assert.equal(view.level, 4);
      assert.equal(view.status, 'mastered');
      assert.equal(view.opportunityScore, 0);
      assert.equal(teacherWord(saved, at).confidence, 100);
      const later = new Date(at.getTime() + 10 * DAY);
      const reloaded = new MemorySystemV2(storage, undefined, 'UTC');
      assert.equal((await reloaded.getWordProficiency('u', 'resilient', later))!.confidence,
        calculateFsrsForgettingCurve(10, saved.stability) * 100);
    }
    at = new Date(saved.nextReview);
  }
});

test('correcting a formal recall reuses its original time and weakens predictions without duplicate exposure or review credit', async () => {
  const { storage, system } = setup();
  await system.importFlashcardWords('u', ['resilient'], undefined, start);
  await system.recordVerification('u', card('correctable'), start);
  const good = (await storage.getMemoryState('u', 'resilient'))!;
  const later = new Date(start.getTime() + 10 * DAY);
  const before = (await system.getWordProficiency('u', 'resilient', later))!;
  const correction = { correctionId: 'correctable-v1', attemptId: 'correctable', wordId: 'resilient',
    rating: 1 as const, expectedRevision: 0 };
  await system.correctFlashcardReview('u', correction, new Date(start.getTime() + 60_000));
  const failed = (await storage.getMemoryState('u', 'resilient'))!;
  assert.equal(failed.lastReview, good.lastReview);
  assert.equal(failed.fsrsCard.reps, 1);
  assert.equal(failed.fsrsReviews.length, 1);
  assert.equal(failed.fsrsReviews[0].rating, 1);
  assert.equal(hasFormalRecallEvidence(failed), true);
  assert.deepEqual(counters(failed), counters(good));
  const after = (await system.getWordProficiency('u', 'resilient', later))!;
  assert.ok(after.memoryScore < before.memoryScore);
  assert.ok(after.confidence! < before.confidence!);
  assert.equal(after.confidence, calculateFsrsForgettingCurve(10, failed.stability) * 100);
  await system.correctFlashcardReview('u', correction, new Date(start.getTime() + 120_000));
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), failed);
});

test('lookup-only cards never predict recall; a later formal recall is independent of passive reading counters', async () => {
  const { storage, system } = setup();
  await system.recordEvent({ userId: 'u', wordId: 'resilient', articleId: 'a', occurrenceId: 'lookup',
    eventType: 'click', occurredAt: start.toISOString(), localDate: '2026-01-01' });
  await system.finalizeHistoricalDates('u', 'UTC');
  const lookup = (await storage.getMemoryState('u', 'resilient'))!;
  assert.equal(lookup.fsrsReviews[0].source, 'reading_lookup');
  assert.equal(hasFormalRecallEvidence(lookup), false);
  assert.equal((await system.getWordProficiency('u', 'resilient', start))!.confidence, 0);
  const single = (await system.getWordProficiency('u', 'resilient', start))!;
  const batch = (await system.getBatchWordProficiency('u', ['resilient'], start)).get('resilient')!;
  const all = (await system.getAllWordProficiency('u', start)).find(word => word.wordId === 'resilient')!;
  for (const view of [single, batch, all]) {
    assert.equal(view.memoryScore, 0);
    assert.equal(view.level, 0);
    assert.equal(view.isIntroduced, true);
    assert.equal(view.status, 'introduced');
  }
  assert.equal(teacherWord(lookup, start).memoryScore, null);
  assert.equal(teacherWord(lookup, start).confidence, null);
  // Existing exposure counters must neither inflate nor suppress formal recall.
  lookup.rme = { ...createEmptyRmeProfile(), failedExposureCount: 1000 };
  await storage.saveMemoryState(lookup);
  const recallAt = new Date(start.getTime() + 2 * DAY);
  await system.recordVerification('u', card('post-lookup'), recallAt);
  const recalled = (await storage.getMemoryState('u', 'resilient'))!;
  assert.equal(hasFormalRecallEvidence(recalled), true);
  const recalledSingle = (await system.getWordProficiency('u', 'resilient', recallAt))!;
  const recalledBatch = (await system.getBatchWordProficiency('u', ['resilient'], recallAt)).get('resilient')!;
  const recalledAll = (await system.getAllWordProficiency('u', recallAt)).find(word => word.wordId === 'resilient')!;
  assert.deepEqual(recalledBatch, recalledSingle);
  assert.deepEqual(recalledAll, recalledSingle);
  assert.ok(recalledSingle.memoryScore > 0);
  assert.equal(recalledSingle.isIntroduced, false);
  assert.equal(recalledSingle.confidence, 100);
  assert.equal(teacherWord(recalled, recallAt).memoryScore, Math.round(recalledSingle.memoryScore));
  assert.deepEqual(counters(recalled), counters(lookup));
});

test('retracting a guessed recognition removes the prediction and replay does not restore withdrawn evidence', async () => {
  const { storage, system } = setup();
  const input: ReadingVerificationInput = { attemptId: 'meaning', questionId: 'q-meaning', wordId: 'resilient',
    articleId: 'a', outcome: 'recognized', selectedOptionId: 'option-1' };
  await system.recordVerification('u', input, start);
  assert.equal((await system.getWordProficiency('u', 'resilient', start))!.confidence, 100);
  const before = (await storage.getMemoryState('u', 'resilient'))!;
  await system.recordVerification('u', { ...input, outcome: 'guessed' }, new Date(start.getTime() + 60_000));
  const withdrawn = (await storage.getMemoryState('u', 'resilient'))!;
  assert.equal(hasFormalRecallEvidence(withdrawn), false);
  assert.equal((await system.getWordProficiency('u', 'resilient', start))!.confidence, 0);
  assert.equal(teacherWord(withdrawn, start).confidence, null);
  assert.deepEqual(counters(withdrawn), counters(before));
  await system.recordVerification('u', input, new Date(start.getTime() + 120_000));
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), withdrawn);
});

test('additional spaced passive encounters remain confirmation targets until an actual recall is saved', async () => {
  const { storage, system } = setup();
  for (let index = 0; index < 4; index += 1) {
    const at = new Date(start.getTime() + index * DAY);
    await system.recordEvent({ userId: 'u', wordId: 'resilient', articleId: `a-${index}`, occurrenceId: `o-${index}`,
      eventType: 'exposure', occurredAt: at.toISOString(), localDate: at.toISOString().slice(0, 10),
      dwellTimeMs: 30_000, expectedDwellTimeMs: 30_000 });
    if (index === 0) continue;
    assert.deepEqual((await system.getConfirmationWords('u', new Date(at.getTime() + DAY), undefined, 'UTC'))
      .map(word => word.wordId), ['resilient']);
  }
  await system.finalizeHistoricalDates('u', 'UTC');
  const passive = (await storage.getMemoryState('u', 'resilient'))!;
  assert.equal(passive.fsrsReviews.length, 0);
  assert.equal((await system.getWordProficiency('u', 'resilient', new Date(start.getTime() + 4 * DAY)))!.confidence, 0);
  assert.equal((await system.getDueWords('u', new Date(start.getTime() + 4 * DAY))).length, 0);
  await system.recordVerification('u', { attemptId: 'first-recall', questionId: 'q-first', wordId: 'resilient',
    articleId: 'a-4', outcome: 'recognized' }, new Date(start.getTime() + 4 * DAY));
  assert.deepEqual(await system.getConfirmationWords('u', new Date(start.getTime() + 5 * DAY), undefined, 'UTC'), []);
});

test('a lookup-only history can return to confirmation after a successful spaced encounter', async () => {
  const { system } = setup();
  const exposure = { userId: 'u', wordId: 'resilient', articleId: 'a', occurrenceId: 'o',
    eventType: 'exposure' as const, occurredAt: start.toISOString(), localDate: '2026-01-01',
    dwellTimeMs: 30_000, expectedDwellTimeMs: 30_000 };
  await system.recordBatchEvents([exposure, { ...exposure, eventType: 'click',
    occurredAt: new Date(start.getTime() + 60_000).toISOString() }]);
  await system.finalizeHistoricalDates('u', 'UTC');
  await system.recordEvent({ ...exposure, occurrenceId: 'spaced', articleId: 'later',
    occurredAt: new Date(start.getTime() + 2 * DAY).toISOString(), localDate: '2026-01-03' });
  assert.deepEqual((await system.getConfirmationWords('u', new Date(start.getTime() + 3 * DAY), undefined, 'UTC'))
    .map(word => word.wordId), ['resilient']);
});

test('legacy reviews without source tags or reconstructed logs retain the FSRS recall prediction', async () => {
  const { storage, system } = setup();
  const state = submitFsrsReview(initializeWordMemory('u', 'resilient'), 3, start);
  const later = new Date(start.getTime() + DAY);
  await storage.saveMemoryState(state);
  const expected = calculateFsrsForgettingCurve(1, state.stability) * 100;
  assert.equal((await system.getWordProficiency('u', 'resilient', later))!.confidence, expected);
  assert.equal(teacherWord(state, later).confidence, Math.round(expected));
  state.fsrsReviews = [];
  state.rme = createEmptyRmeProfile();
  await storage.saveMemoryState(state);
  assert.equal((await system.getWordProficiency('u', 'resilient', later))!.confidence, expected);
  assert.equal(teacherWord(state, later).confidence, Math.round(expected));
  const withLookupTail = submitFsrsReview(state, 1, later);
  withLookupTail.fsrsReviews[0].source = 'reading_lookup';
  await storage.saveMemoryState(withLookupTail);
  assert.equal(withLookupTail.fsrsCard.reps, 2);
  assert.equal(hasFormalRecallEvidence(withLookupTail), true);
  const afterLookup = new Date(later.getTime() + DAY);
  assert.equal((await system.getWordProficiency('u', 'resilient', afterLookup))!.confidence,
    calculateFsrsForgettingCurve(1, withLookupTail.stability) * 100);
});
