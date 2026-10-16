import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { finalizeDailyEvidence, initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { replayVerificationEvidence } from '../src/lib/memoryV2/verificationMemory';
import { appendJournalEvents } from '../src/lib/browserExtension/importer';
import { collectAppLocalStorage } from '../src/lib/localDataBackup';
import type { RawWordEvent, ReadingVerificationEvidence, ReadingVerificationInput } from '../src/lib/memoryV2/types';

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
  return { storage, browser, system: new MemorySystemV2(storage, undefined, 'UTC') };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });
const input = (outcome: ReadingVerificationInput['outcome'], attemptId = 'pause-1'): ReadingVerificationInput => ({
  attemptId, questionId: 'q-run-v1', wordId: 'run', articleId: 'a', outcome,
  ...(['recognized', 'incorrect', 'guessed'].includes(outcome) ? { selectedOptionId: 'option-1' } : {}),
});
const at = new Date('2026-09-03T12:00:00.000Z');

test('immediate practice persists outcomes without adding success, failure or FSRS memory evidence', async () => {
  const { system, storage } = setup();
  await system.recordBatchEvents([{ userId: 'u', wordId: 'run', articleId: 'a', occurrenceId: 'p0:run',
    eventType: 'exposure', occurredAt: at.toISOString(), localDate: '2026-09-03',
    dwellTimeMs: 30_000, expectedDwellTimeMs: 30_000 }]);
  const before = await storage.getMemoryState('u', 'run');
  for (const outcome of ['recognized', 'incorrect', 'uncertain', 'skipped'] as const) {
    await system.recordVerification('u', { ...input(outcome, `practice-${outcome}`), purpose: 'immediate_practice' }, at);
    assert.deepEqual(await storage.getMemoryState('u', 'run'), before);
  }
  await system.recordVerification('u', { ...input('guessed', 'practice-recognized'), purpose: 'immediate_practice' }, at);
  assert.deepEqual(await storage.getMemoryState('u', 'run'), before);
  assert.equal((await system.getVerificationHistory('u'))[0].outcome, 'guessed');
  assert.ok((await system.getVerificationHistory('u')).every(row => row.purpose === 'immediate_practice'));
  await assert.rejects(system.recordVerification('u', { ...input('guessed', 'practice-recognized'), purpose: 'delayed_verification' }, at), /冲突/);
});

test('an immediate-practice error does not overwrite an independent delayed review', async () => {
  const { system, storage } = setup();
  await system.recordVerification('u', input('recognized', 'delayed'), at);
  const before = await storage.getMemoryState('u', 'run');
  await system.recordVerification('u', { ...input('incorrect', 'practice'), purpose: 'immediate_practice' }, at);
  assert.deepEqual(await storage.getMemoryState('u', 'run'), before);
});

test('practice replay preserves imported verification reviews even when their original journal is absent', async () => {
  const { system, storage } = setup();
  const imported = submitFsrsReview(initializeWordMemory('u', 'run'), 2, at);
  imported.fsrsReviews[0].source = 'verification';
  imported.fsrsReviews[0].verificationAttemptIds = ['external-verified'];
  await storage.saveMemoryState(imported);
  await system.recordVerification('u', { ...input('incorrect', 'practice-only'), purpose: 'immediate_practice' }, at);
  assert.deepEqual(await storage.getMemoryState('u', 'run'), imported);
  const attempts = await system.getVerificationHistory('u');
  assert.deepEqual(replayVerificationEvidence(imported, attempts, 'UTC', [], at), imported);
});
const exposure = (day: string, clicked = false): RawWordEvent[] => {
  const row: RawWordEvent = { userId: 'u', wordId: 'run', articleId: `reading-${day}`,
    occurrenceId: `${day}:p0`, eventType: 'exposure', occurredAt: `${day}T10:00:00.000Z`,
    localDate: day, dwellTimeMs: 30_000, expectedDwellTimeMs: 30_000 };
  return clicked ? [row, { ...row, eventType: 'click', occurredAt: `${day}T10:01:00.000Z` }] : [row];
};

test('passive reading stays separate from a persistent, conservatively scheduled correct recognition', async () => {
  const { system, storage, browser } = setup();
  for (const day of ['2026-09-01', '2026-09-02', '2026-09-03']) {
    await system.recordBatchEvents(exposure(day));
  }
  await system.finalizeHistoricalDates('u', 'UTC');
  assert.equal((await storage.getMemoryState('u', 'run'))!.fsrsReviews.length, 0);
  await system.recordVerification('u', input('recognized'), at);
  const state = (await storage.getMemoryState('u', 'run'))!;
  assert.equal(state.fsrsReviews.length, 1);
  assert.equal(state.fsrsReviews[0].rating, 2);
  assert.equal(state.fsrsReviews[0].source, 'verification');
  assert.equal(state.lastReview, at.toISOString());
  assert.notEqual((await system.getWordProficiency('u', 'run', at))?.status, 'mastered');
  assert.equal((await system.getVerificationHistory('u'))[0].outcome, 'recognized');
  assert.ok(Object.keys(collectAppLocalStorage(browser)).some(key => key.includes('reading-verification:')));
});

test('recognized to guessed retracts only its own review and old retries cannot restore it', async () => {
  const { system, storage } = setup();
  await system.recordVerification('u', input('recognized'), at);
  await system.recordVerification('u', input('guessed'), new Date('2026-09-03T12:05:00Z'));
  await system.recordVerification('u', input('recognized'), new Date('2026-09-03T12:06:00Z'));
  const state = (await storage.getMemoryState('u', 'run'))!;
  assert.equal(state.fsrsReviews.length, 0);
  assert.equal(state.fsrsCard.reps, 0);
  assert.equal(state.lastReview, null);
  const history = await system.getVerificationHistory('u');
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, 'guessed');
  assert.equal(history[0].occurredAt, at.toISOString());
});

test('wrong and uncertain answers need review; skipped and guessed answers do not grade FSRS', async () => {
  for (const outcome of ['incorrect', 'uncertain', 'skipped', 'guessed'] as const) {
    const { system, storage } = setup();
    await system.recordVerification('u', input(outcome), at);
    const state = await storage.getMemoryState('u', 'run');
    assert.equal(state?.fsrsReviews.length ?? 0, ['incorrect', 'uncertain'].includes(outcome) ? 1 : 0);
    if (state) assert.equal(state.fsrsReviews[0]?.rating, 1);
    assert.equal((await system.getVerificationHistory('u'))[0].outcome, outcome);
  }
});

test('retries are idempotent, identities are frozen, and same-day failure outranks recognition', async () => {
  const { system, storage } = setup();
  await system.recordVerification('u', input('recognized'), at);
  await system.recordVerification('u', input('recognized'), new Date('2026-09-03T13:00:00Z'));
  await assert.rejects(system.recordVerification('u', { ...input('recognized'), questionId: 'another-q' }, at), /冲突/);
  await system.recordVerification('u', input('incorrect', 'pause-2'), new Date('2026-09-03T14:00:00Z'));
  await system.recordVerification('u', input('recognized', 'pause-3'), new Date('2026-09-03T15:00:00Z'));
  const state = (await storage.getMemoryState('u', 'run'))!;
  assert.equal(state.fsrsReviews.length, 1);
  assert.equal(state.fsrsReviews[0].rating, 1);
  assert.equal(state.fsrsCard.reps, 1);
  assert.equal((await system.getVerificationHistory('u')).length, 3);
});

test('an independent lookup survives guess correction and keeps its actual help time', async () => {
  const { system, storage } = setup();
  await system.recordVerification('u', input('recognized'), at);
  await system.recordBatchEvents(exposure('2026-09-03', true));
  await system.recordVerification('u', input('guessed'), new Date('2026-09-03T13:00:00Z'));
  const state = (await storage.getMemoryState('u', 'run'))!;
  assert.equal(state.fsrsReviews.length, 1);
  assert.equal(state.fsrsReviews[0].rating, 1);
  assert.equal(state.fsrsReviews[0].source, 'reading_lookup');
  assert.equal(state.lastAssistedAt, '2026-09-03T10:01:00.000Z');
});

test('guess correction replays later reviews while keeping unrelated legacy history', () => {
  let baseline = initializeWordMemory('u', 'run');
  baseline = submitFsrsReview(baseline, 3, new Date('2026-09-01T12:00:00Z'));
  const attempt: ReadingVerificationEvidence = { ...input('recognized'), userId: 'u',
    occurredAt: at.toISOString(), localDate: '2026-09-03', timezone: 'UTC' };
  let withCheck = replayVerificationEvidence(baseline, [attempt], 'UTC', [], at)!;
  withCheck = submitFsrsReview(withCheck, 3, new Date('2026-09-05T12:00:00Z'));
  const corrected = replayVerificationEvidence(withCheck, [{ ...attempt, outcome: 'guessed' }], 'UTC', [],
    new Date('2026-09-06T12:00:00Z'))!;
  const expected = submitFsrsReview(baseline, 3, new Date('2026-09-05T12:00:00Z'));
  assert.deepEqual(corrected.fsrsCard, expected.fsrsCard);
  assert.deepEqual(corrected.fsrsReviews, expected.fsrsReviews);
});

test('a late lookup correction retains the source of a later recognition check', () => {
  let baseline = submitFsrsReview(initializeWordMemory('u', 'run'), 3, new Date('2026-09-01T12:00:00Z'));
  const attempt: ReadingVerificationEvidence = { ...input('recognized'), userId: 'u',
    occurredAt: at.toISOString(), localDate: '2026-09-03', timezone: 'UTC' };
  const checked = replayVerificationEvidence(baseline, [attempt], 'UTC', [], at)!;
  const revised = finalizeDailyEvidence(checked, { userId: 'u', wordId: 'run', localDate: '2026-09-01',
    articleEvidence: [], articleCount: 1, validExposureCount: 1, clickedOccurrenceCount: 1,
    pendingGrade: 'Again', finalizedAt: null }, 'u', 'UTC')!;
  assert.equal(revised.fsrsReviews[1].source, 'verification');
  const guessed = replayVerificationEvidence(revised, [{ ...attempt, outcome: 'guessed' }], 'UTC', [],
    new Date('2026-09-06T12:00:00Z'))!;
  assert.deepEqual(guessed.fsrsReviews.map(review => review.rating), [1]);
  assert.equal(guessed.fsrsCard.reps, 1);
});

test('plugin replay and delayed events preserve verification without duplicate day reviews', async () => {
  const { system, storage } = setup();
  await system.recordBatchEvents(exposure('2026-09-01'));
  await system.recordVerification('u', input('recognized'), at);
  const incoming = exposure('2026-09-04', true).map(row => ({ ...row,
    occurrenceId: `extension:${row.occurrenceId}` }));
  await appendJournalEvents(storage, incoming, 'UTC', new Date('2026-09-06T12:00:00Z'), true);
  let state = (await storage.getMemoryState('u', 'run'))!;
  assert.deepEqual(state.fsrsReviews.map(review => review.rating), [2, 1]);
  await system.recordVerification('u', input('guessed'), new Date('2026-09-06T13:00:00Z'));
  state = (await storage.getMemoryState('u', 'run'))!;
  assert.deepEqual(state.fsrsReviews.map(review => review.rating), [1]);
  await appendJournalEvents(storage, incoming, 'UTC', new Date('2026-09-07T12:00:00Z'), true);
  assert.deepEqual((await storage.getMemoryState('u', 'run'))!.fsrsReviews, state.fsrsReviews);
});

test('a crash after durable answer save is recovered on the next initialization', async () => {
  const { system, storage } = setup();
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('interrupted derived write'); };
  await assert.rejects(system.recordVerification('u', input('recognized'), at), /interrupted/);
  assert.equal((await system.getVerificationHistory('u')).length, 1);
  storage.saveMemoryState = save;
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.finalizeHistoricalDates('u', 'UTC');
  assert.equal((await storage.getMemoryState('u', 'run'))!.fsrsReviews[0].rating, 2);
});
