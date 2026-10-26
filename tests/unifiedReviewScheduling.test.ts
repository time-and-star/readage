import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { saveFlashcardDesiredRetention } from '../src/lib/flashcardPreferences';
import { finalizeDailyEvidence, initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { appendJournalEvents } from '../src/lib/browserExtension/importer';
import { replayVerificationEvidence } from '../src/lib/memoryV2/verificationMemory';
import type { DailyWordEvidence, ReadingVerificationEvidence, ReadingVerificationInput, WordMemoryState } from '../src/lib/memoryV2/types';

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
const userId = 'isolated-unified-review';
const at = new Date('2026-10-24T10:00:00.000Z');
const after = (minutes: number) => new Date(at.getTime() + minutes * 60_000);
const policy = createFlashcardSchedulingPolicy(0.93);
const input = (outcome: ReadingVerificationInput['outcome'], attemptId = 'read-1'): ReadingVerificationInput => ({
  attemptId, questionId: `question-${attemptId}`, articleId: 'article', wordId: 'recall', outcome,
});
function flashcard(state = initializeWordMemory(userId, 'recall'), rating: 1 | 2 | 3 | 4 = 3, time = at) {
  const next = submitFsrsReview(state, rating, time, policy);
  Object.assign(next.fsrsReviews.at(-1)!, { source: 'flashcard', localDate: time.toISOString().slice(0, 10),
    verificationAttemptIds: [`card-${next.fsrsCard.reps}`] });
  return next;
}
function failure(time: Date): DailyWordEvidence {
  const localDate = time.toISOString().slice(0, 10);
  return { userId, wordId: 'recall', localDate, articleCount: 1, validExposureCount: 0,
    clickedOccurrenceCount: 1, recallFailureCount: 1, pendingGrade: 'Again', finalizedAt: null,
    articleEvidence: [{ userId, wordId: 'recall', localDate, articleId: 'article',
      validExposureCount: 0, clickedOccurrenceCount: 1, recallFailureCount: 1,
      firstSeenAt: time.toISOString(), lastSeenAt: time.toISOString(), lastRecallFailureAt: time.toISOString() }],
  };
}

test('reading recognition shares current retention and preserves the unfinished learning state', async () => {
  const { storage, system } = setup();
  await saveFlashcardDesiredRetention(storage, userId, 0.96);
  const before = flashcard();
  await storage.saveMemoryState(before);
  await system.recordVerification(userId, input('recognized'), after(1));
  const saved = (await storage.getMemoryState(userId, 'recall'))!;
  const currentPolicy = createFlashcardSchedulingPolicy(0.96);
  const expected = submitFsrsReview(before, 2, after(1), currentPolicy);
  assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
  assert.equal(saved.fsrsCard.state, 1);
  assert.equal(saved.fsrsCard.learningSteps, 1);
  assert.equal(saved.nextReview, after(1).toISOString());
  assert.equal(saved.fsrsReviews.at(-1)!.rating, 2);
  assert.deepEqual(saved.fsrsReviews.at(-1)!.scheduling, currentPolicy);
  assert.deepEqual((await system.getVerificationHistory(userId))[0].scheduling, currentPolicy);
});

test('reading failure returns a mature word to the same persisted relearning rounds', async () => {
  const { storage, system } = setup();
  let before = flashcard();
  before = flashcard(flashcard(before));
  await storage.saveMemoryState(before);
  await system.recordVerification(userId, input('incorrect'), after(1));
  const saved = (await storage.getMemoryState(userId, 'recall'))!;
  assert.equal(saved.fsrsCard.state, 3);
  assert.equal(saved.fsrsCard.learningSteps, 0);
  assert.equal(saved.nextReview, after(1).toISOString());
  assert.equal(saved.fsrsCard.lapses, before.fsrsCard.lapses + 1);
  assert.deepEqual(saved.fsrsReviews.at(-1)!.scheduling, createFlashcardSchedulingPolicy());
});

test('reading retries and crash recovery retain the original policy after the preference changes', async () => {
  const { storage, system } = setup();
  await saveFlashcardDesiredRetention(storage, userId, 0.96);
  const originalSave = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('isolated derived-state failure'); };
  await assert.rejects(system.recordVerification(userId, input('recognized'), at), /derived-state failure/);
  storage.saveMemoryState = originalSave;
  await saveFlashcardDesiredRetention(storage, userId, 0.8);
  await system.recordVerification(userId, input('recognized'), after(1));
  const saved = (await storage.getMemoryState(userId, 'recall'))!;
  const history = await system.getVerificationHistory(userId);
  assert.deepEqual(history[0].scheduling, createFlashcardSchedulingPolicy(0.96));
  assert.equal(history[0].occurredAt, at.toISOString());
  assert.equal(saved.fsrsCard.reps, 1);
  assert.deepEqual(saved.fsrsReviews[0].scheduling, history[0].scheduling);
  await system.recordVerification(userId, input('recognized'), after(2));
  assert.deepEqual(await storage.getMemoryState(userId, 'recall'), saved);
  await system.recordVerification(userId, input('guessed'), after(3));
  assert.equal((await storage.getMemoryState(userId, 'recall'))!.fsrsCard.reps, 0);
  assert.deepEqual((await system.getVerificationHistory(userId))[0].scheduling, history[0].scheduling);
});

test('guessed, skipped and immediate practice never create formal review schedules', async () => {
  const { storage, system } = setup();
  for (const outcome of ['guessed', 'skipped'] as const) await system.recordVerification(userId, input(outcome, outcome), at);
  for (const outcome of ['recognized', 'incorrect', 'uncertain'] as const) {
    await system.recordVerification(userId, { ...input(outcome, outcome), purpose: 'immediate_practice' }, at);
  }
  assert.equal(await storage.getMemoryState(userId, 'recall'), null);
  assert.ok((await system.getVerificationHistory(userId)).every(attempt => attempt.scheduling === undefined));
});

for (const version of [undefined, 1, 2, 3, 4] as const) {
  test(`historical reading policy ${version ?? 'legacy'} is replayed without upgrading its due or learning state`, () => {
    const frozen = version ? createFlashcardSchedulingPolicy(0.87, version) : undefined;
    const attempt: ReadingVerificationEvidence = { ...input('recognized'), userId, timezone: 'UTC',
      occurredAt: at.toISOString(), localDate: '2026-10-24', ...(frozen ? { scheduling: frozen } : {}) };
    const saved = replayVerificationEvidence(null, [attempt], 'UTC', [], at)!;
    const expected = submitFsrsReview(initializeWordMemory(userId, 'recall'), 2, at, frozen);
    assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
    assert.deepEqual(saved.fsrsReviews[0].scheduling, frozen);
    assert.deepEqual(replayVerificationEvidence(saved, [attempt], 'UTC', [], after(1)), saved);
  });
}

test('a new daily failure inherits the preceding formal policy and persists it for later replay', () => {
  const before = flashcard();
  const saved = finalizeDailyEvidence(before, failure(after(1)), userId, 'UTC')!;
  assert.equal(saved.fsrsCard.state, 1);
  assert.equal(saved.fsrsCard.learningSteps, 0);
  assert.equal(saved.nextReview, after(1).toISOString());
  assert.deepEqual(saved.fsrsReviews.at(-1)!.scheduling, policy);
  const expected = submitFsrsReview(before, 1, after(1), policy);
  assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
});

test('late daily failure is inserted before a saved word card without losing its source or frozen policy', () => {
  const before = flashcard();
  Object.assign(before.fsrsReviews[0], { originalFlashcardRating: 1,
    flashcardRevisions: [{ correctionId: 'fixed', revision: 1, previousRating: 1, rating: 3, correctedAt: after(1).toISOString() }] });
  const latePolicy = createFlashcardSchedulingPolicy(0.97);
  const saved = finalizeDailyEvidence(before, failure(after(-1)), userId, 'UTC', latePolicy)!;
  const priorFailure = submitFsrsReview(initializeWordMemory(userId, 'recall'), 1, after(-1), latePolicy);
  const expected = submitFsrsReview(priorFailure, 3, at, policy);
  assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
  assert.deepEqual(saved.fsrsReviews.map(review => review.source), ['reading_lookup', 'flashcard']);
  assert.deepEqual(saved.fsrsReviews.map(review => review.scheduling), [latePolicy, policy]);
  assert.equal(saved.fsrsReviews[0].verificationAttemptIds, undefined);
  assert.equal(saved.fsrsReviews[0].originalFlashcardRating, undefined);
  assert.equal(saved.fsrsReviews[0].flashcardRevisions, undefined);
  assert.deepEqual(saved.fsrsReviews[1].verificationAttemptIds, before.fsrsReviews[0].verificationAttemptIds);
  assert.deepEqual(saved.fsrsReviews[1].flashcardRevisions, before.fsrsReviews[0].flashcardRevisions);
  assert.deepEqual(finalizeDailyEvidence(saved, failure(after(-1)), userId, 'UTC', policy), saved);
});

test('a late correction moves the daily failure chronologically while retaining the original policy', () => {
  const legacyPolicy = createFlashcardSchedulingPolicy(0.88, 1);
  let before = submitFsrsReview(initializeWordMemory(userId, 'recall'), 2, at, legacyPolicy);
  Object.assign(before.fsrsReviews[0], { source: 'verification', localDate: '2026-10-24', verificationAttemptIds: ['old'] });
  before = flashcard(before, 3, after(1));
  const saved = finalizeDailyEvidence(before, failure(after(2)), userId, 'UTC', policy)!;
  const first = flashcard(initializeWordMemory(userId, 'recall'), 3, after(1));
  const expected = submitFsrsReview(first, 1, after(2), legacyPolicy);
  assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
  assert.deepEqual(saved.fsrsReviews.map(review => review.source), ['flashcard', 'reading_lookup']);
  assert.deepEqual(saved.fsrsReviews.at(-1)!.scheduling, legacyPolicy);
  assert.equal(saved.fsrsCard.reps, 2);
});

test('revising a daily decision preserves its position among same-millisecond recalls', () => {
  let before = submitFsrsReview(initializeWordMemory(userId, 'recall'), 2, at, policy);
  Object.assign(before.fsrsReviews[0], { source: 'verification', localDate: '2026-10-24', verificationAttemptIds: ['same-time'] });
  before = flashcard(before, 3, at);
  const saved = finalizeDailyEvidence(before, failure(at), userId, 'UTC', policy)!;
  const failed = submitFsrsReview(initializeWordMemory(userId, 'recall'), 1, at, policy);
  const expected = submitFsrsReview(failed, 3, at, policy);
  assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
  assert.deepEqual(saved.fsrsReviews.map(review => review.source), ['reading_lookup', 'flashcard']);
  assert.deepEqual(saved.fsrsReviews.map(review => review.rating), [1, 3]);
});

test('old daily decisions without a policy remain legacy when revised after the new policy exists', () => {
  const before = submitFsrsReview(initializeWordMemory(userId, 'recall'), 3, at);
  const saved = finalizeDailyEvidence(before, failure(after(1)), userId, 'UTC', policy)!;
  const expected = submitFsrsReview(initializeWordMemory(userId, 'recall'), 1, after(1));
  assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
  assert.equal(saved.fsrsReviews[0].scheduling, undefined);
});

test('a historical failure never borrows a later recall policy or rewinds an unlogged migration baseline', () => {
  const before = flashcard();
  const inserted = finalizeDailyEvidence(before, failure(after(-1)), userId, 'UTC')!;
  assert.equal(inserted.fsrsReviews[0].scheduling, undefined);
  assert.deepEqual(inserted.fsrsReviews[1].scheduling, policy);
  const imported = { ...before, fsrsReviews: [] };
  assert.deepEqual(finalizeDailyEvidence(imported, failure(after(-1)), userId, 'UTC', policy), imported);
});

test('extension replay preserves the frozen reading and lookup policies across repeated imports', async () => {
  const { storage, system } = setup();
  await saveFlashcardDesiredRetention(storage, userId, 0.94);
  await system.recordVerification(userId, input('recognized'), at);
  const occurredAt = '2026-10-25T10:00:00.000Z';
  const events = [{ userId, wordId: 'recall', articleId: 'external', occurrenceId: 'external:recall',
    eventType: 'click' as const, occurredAt, localDate: '2026-10-25' }];
  const now = new Date('2026-10-26T12:00:00.000Z');
  await appendJournalEvents(storage, events, 'UTC', now, true);
  const saved = (await storage.getMemoryState(userId, 'recall'))!;
  assert.deepEqual(saved.fsrsReviews.map(review => review.source), ['verification', 'reading_lookup']);
  assert.ok(saved.fsrsReviews.every(review => review.scheduling?.version === createFlashcardSchedulingPolicy().version && review.scheduling.desiredRetention === 0.94));
  assert.equal(saved.fsrsCard.state, 1);
  await saveFlashcardDesiredRetention(storage, userId, 0.8);
  await appendJournalEvents(storage, events, 'UTC', now, true);
  const retried = (await storage.getMemoryState(userId, 'recall'))!;
  assert.deepEqual(retried.fsrsCard, saved.fsrsCard);
  assert.deepEqual(retried.fsrsReviews, saved.fsrsReviews);
});

test('a backwards reading clock cannot poison an opaque imported baseline or block a later valid recall', async () => {
  const { storage, system } = setup();
  const imported = { ...flashcard(), fsrsReviews: [] };
  await storage.saveMemoryState(imported);
  for (const outcome of ['recognized', 'incorrect', 'uncertain'] as const) {
    await assert.rejects(system.recordVerification(userId, input(outcome, `backwards-${outcome}`), after(-60)), /设备时间/);
    assert.deepEqual(await storage.getMemoryState(userId, 'recall'), imported);
    assert.deepEqual(await system.getVerificationHistory(userId), []);
  }
  const nextDay = after(24 * 60);
  await system.recordVerification(userId, input('recognized', 'valid-after-clock-fix'), nextDay);
  const saved = (await storage.getMemoryState(userId, 'recall'))!;
  assert.equal(saved.fsrsCard.reps, imported.fsrsCard.reps + 1);
  assert.equal(saved.lastReview, nextDay.toISOString());
  assert.equal((await system.getVerificationHistory(userId)).length, 1);
});

test('a backwards reading clock also respects a durable recall awaiting derived-state recovery', async () => {
  const { storage, system } = setup();
  const originalSave = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('isolated pending recall'); };
  await assert.rejects(system.recordVerification(userId, input('recognized', 'durable'), at), /pending recall/);
  storage.saveMemoryState = originalSave;
  const history = await system.getVerificationHistory(userId);
  await assert.rejects(system.recordVerification(userId, input('incorrect', 'backwards'), after(-1)), /设备时间/);
  assert.deepEqual(await system.getVerificationHistory(userId), history);
  await system.recordVerification(userId, input('recognized', 'durable'), after(1));
  assert.equal((await storage.getMemoryState(userId, 'recall'))!.fsrsCard.reps, 1);
});

test('same-millisecond reading then word-card recalls retain journal order and the earned learning step', async () => {
  const { storage, system } = setup();
  await system.recordVerification(userId, input('recognized', 'reading-first'), at);
  const before = (await storage.getMemoryState(userId, 'recall'))!;
  const card = { ...input('recognized', 'card-second'), purpose: 'flashcard_review' as const,
    rating: 3 as const, scheduling: policy, expectedReps: 1 };
  await system.recordVerification(userId, card, at);
  const saved = (await storage.getMemoryState(userId, 'recall'))!;
  assert.deepEqual(saved.fsrsReviews.map(review => review.source), ['verification', 'flashcard']);
  assert.deepEqual(saved.fsrsReviews.map(review => review.rating), [2, 3]);
  assert.deepEqual(saved.fsrsCard, submitFsrsReview(before, 3, at, policy).fsrsCard);
  assert.equal(saved.fsrsCard.learningSteps, 1);
  await system.recordVerification(userId, card, after(1));
  assert.deepEqual(await storage.getMemoryState(userId, 'recall'), saved);
});

test('same-millisecond word-card then reading recalls and expanded reading aggregates preserve observed order', async () => {
  const { storage, system } = setup();
  await system.importFlashcardWords(userId, ['recall'], undefined, at);
  await system.recordVerification(userId, { ...input('recognized', 'card-first'), purpose: 'flashcard_review',
    rating: 3, scheduling: policy, expectedReps: 0 }, at);
  await system.recordVerification(userId, input('recognized', 'reading-second'), at);
  let saved = (await storage.getMemoryState(userId, 'recall'))!;
  assert.deepEqual(saved.fsrsReviews.map(review => review.source), ['flashcard', 'verification']);
  assert.equal(saved.fsrsCard.learningSteps, 1);
  await system.recordVerification(userId, { ...input('recognized', 'card-third'), purpose: 'flashcard_review',
    rating: 3, scheduling: policy, expectedReps: 2 }, at);
  await system.recordVerification(userId, input('recognized', 'reading-fourth'), at);
  saved = (await storage.getMemoryState(userId, 'recall'))!;
  assert.deepEqual(saved.fsrsReviews.map(review => review.source), ['flashcard', 'flashcard', 'verification']);
  assert.equal(saved.fsrsCard.learningSteps, 2);
  assert.equal(saved.fsrsCard.reps, 3);
});

test('same-millisecond replay of legacy reading entries retains its historical ordering', () => {
  const legacy: ReadingVerificationEvidence = { ...input('recognized', 'legacy-reading'), userId, timezone: 'UTC',
    occurredAt: at.toISOString(), localDate: '2026-10-24' };
  const card: ReadingVerificationEvidence = { ...legacy, attemptId: 'legacy-card', purpose: 'flashcard_review',
    rating: 3, scheduling: policy };
  const saved = replayVerificationEvidence(null, [legacy, card], 'UTC', [], at)!;
  assert.deepEqual(saved.fsrsReviews.map(review => review.source), ['flashcard', 'verification']);
  assert.equal(saved.fsrsReviews[1].scheduling, undefined);
});
