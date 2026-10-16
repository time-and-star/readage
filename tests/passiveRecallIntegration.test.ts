import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFlashcardQueue } from '../src/lib/flashcardReview';
import { buildForgettingCurveModel } from '../src/lib/forgettingCurve';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { replayVerificationEvidence, saveVerificationAttempt } from '../src/lib/memoryV2/verificationMemory';
import type { DailyWordEvidence, ReadingVerificationEvidence, WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
}
const now = new Date('2026-10-09T12:00:00Z');
function passive(wordId: string) {
  const baseline = initializeWordMemory('u', wordId);
  baseline.nextReview = baseline.fsrsCard.due = '2026-08-01T00:00:00Z';
  const state = submitFsrsReview(baseline, 3, new Date('2026-08-01T23:59:59.999Z'));
  const day: DailyWordEvidence = { userId: 'u', wordId, localDate: '2026-08-01',
    articleCount: 1, validExposureCount: 1, clickedOccurrenceCount: 0, pendingGrade: 'Good',
    finalizedAt: '2026-08-02T00:00:00Z', articleEvidence: [{ userId: 'u', wordId, articleId: 'article',
      localDate: '2026-08-01', validExposureCount: 1, clickedOccurrenceCount: 0,
      firstSeenAt: '2026-08-01T12:00:00Z', lastSeenAt: '2026-08-01T12:00:00Z' }] };
  return { state, day, baseline };
}
function withBrowser() {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new BrowserStorage() } });
  return { storage: new LocalStorageMemoryStorage(), restore() {
    if (prior) Object.defineProperty(globalThis, 'window', prior); else Reflect.deleteProperty(globalThis, 'window');
  } };
}

test('startup repairs settled passive history once, preserves enrollment, and feeds clean schedules to cards and predictions', async t => {
  const fixture = withBrowser();
  try {
    const { storage } = fixture;
    const system = new MemorySystemV2(storage, undefined, 'UTC');
    const incidental = passive('incidental');
    const mixed = passive('mixed');
    const at = new Date('2026-09-01T12:00:00Z');
    const scored = submitFsrsReview(mixed.state, 3, at);
    scored.fsrsReviews.at(-1)!.source = 'flashcard';
    scored.fsrsReviews.at(-1)!.verificationAttemptIds = ['real:1'];
    const expected = submitFsrsReview(mixed.baseline, 3, at);
    const legacy = passive('unproven').state;
    const enrollment = { version: 1, userId: 'u', dailyNewWordLimit: 0, importedWordIds: ['incidental'], pausedWordIds: ['unproven'] };
    await storage.setMeta('flashcard-study-preferences:u', enrollment);
    for (const state of [incidental.state, scored, legacy]) await storage.saveMemoryState(state);
    for (const day of [incidental.day, mixed.day]) await storage.saveDailyEvidence(day);
    let scans = 0, writes = 0;
    const readAll = storage.getAllDailyEvidence.bind(storage), save = storage.saveMemoryState.bind(storage);
    t.mock.method(storage, 'getAllDailyEvidence', async (userId: string) => { scans++; return readAll(userId); });
    t.mock.method(storage, 'saveMemoryState', async (state: WordMemoryState) => { writes++; return save(state); });
    await system.finalizeHistoricalDates('u', 'UTC');
    assert.equal(scans, 1, 'settled evidence is loaded once rather than once per vocabulary word');
    assert.equal(writes, 2);
    const states = await system.getReadingVerificationMemoryStates('u');
    const clean = states.find(state => state.wordId === 'mixed')!;
    assert.deepEqual(clean.fsrsCard, expected.fsrsCard);
    assert.equal(clean.fsrsReviews.length, 1);
    assert.deepEqual(clean.fsrsReviews[0].verificationAttemptIds, ['real:1']);
    assert.equal(clean.passiveReadingReviews?.length, 1);
    assert.deepEqual(await storage.getMemoryState('u', 'unproven'), legacy, 'a source-free imported recall without proof survives');
    assert.deepEqual(await storage.getDailyEvidence('u', 'incidental', '2026-08-01'), incidental.day);
    assert.deepEqual(await storage.getMeta('flashcard-study-preferences:u'), enrollment);
    const queue = buildFlashcardQueue(states, { now, timezone: 'UTC', newWordLimit: 0,
      enrolledWordIds: new Set(enrollment.importedWordIds), pausedWordIds: new Set(enrollment.pausedWordIds) });
    assert.equal(queue.dueCount, 1);
    assert.equal(queue.remainingNewCount, 1, 'explicitly enrolled passive words remain enrolled new cards');
    assert.deepEqual(queue.cards.map(card => card.wordId), ['mixed']);
    const curve = buildForgettingCurveModel(states, { now, horizonDays: 7 }).personal.allWords;
    assert.equal(curve.wordCount, 1);
    assert.deepEqual(curve.stabilityDaysByWord, [expected.stability]);
    await system.finalizeHistoricalDates('u', 'UTC');
    assert.equal(writes, 2, 'reopening cannot add ratings or rewrite an already repaired card');
  } finally { fixture.restore(); }
});

test('canonical seeding repairs the actual alias evidence before copying its schedule', async () => {
  const fixture = withBrowser();
  try {
    const original = passive('running');
    await fixture.storage.saveMemoryState(original.state);
    await fixture.storage.saveDailyEvidence(original.day);
    await new MemorySystemV2(fixture.storage, undefined, 'UTC').seedCanonicalWordMemory('u', 'run', ['running']);
    const canonical = (await fixture.storage.getMemoryState('u', 'run'))!;
    assert.equal(canonical.fsrsCard.reps, 0);
    assert.equal(canonical.fsrsReviews.length, 0);
    assert.equal(canonical.passiveReadingReviews?.length, 1);
    assert.deepEqual(await fixture.storage.getMemoryState('u', 'running'), original.state);
    assert.deepEqual(await fixture.storage.getDailyEvidence('u', 'running', '2026-08-01'), original.day);
  } finally { fixture.restore(); }
});

test('an existing canonical copy uses exact alias history for repair without resetting an independent recall', async () => {
  const fixture = withBrowser();
  try {
    const original = passive('running');
    await fixture.storage.saveMemoryState(original.state);
    await fixture.storage.saveDailyEvidence(original.day);
    await fixture.storage.saveMemoryState({ ...original.state, wordId: 'run' });
    const system = new MemorySystemV2(fixture.storage, undefined, 'UTC');
    await system.seedCanonicalWordMemory('u', 'run', ['running']);
    assert.equal((await fixture.storage.getMemoryState('u', 'run'))!.fsrsCard.reps, 0);
    const independent = submitFsrsReview(original.baseline, 4, new Date('2026-09-01T12:00:00Z'));
    independent.wordId = 'run';
    await fixture.storage.saveMemoryState(independent);
    await system.seedCanonicalWordMemory('u', 'run', ['running']);
    assert.deepEqual(await fixture.storage.getMemoryState('u', 'run'), independent);
    assert.deepEqual(await fixture.storage.getDailyEvidence('u', 'running', '2026-08-01'), original.day);
  } finally { fixture.restore(); }
});

test('fallback evidence reads tolerate an invalid legacy timestamp without blocking initialization', async () => {
  const fixture = withBrowser();
  try {
    const original = passive('malformed');
    original.state.fsrsReviews[0].review = 'invalid';
    await fixture.storage.saveMemoryState(original.state);
    Object.defineProperty(fixture.storage, 'getAllDailyEvidence', { value: undefined });
    Object.defineProperty(fixture.storage, 'getWordDailyEvidence', { value: undefined });
    await new MemorySystemV2(fixture.storage, undefined, 'UTC').finalizeHistoricalDates('u', 'UTC');
    assert.deepEqual(await fixture.storage.getMemoryState('u', 'malformed'), original.state);
  } finally { fixture.restore(); }
});

test('dictionary-confirmed batch repair finds archived alias proof and does not create extra canonical cards', async () => {
  const fixture = withBrowser();
  try {
    const original = passive('running');
    await fixture.storage.saveMemoryState(original.state);
    await fixture.storage.saveDailyEvidence(original.day);
    await fixture.storage.saveMemoryState({ ...original.state, wordId: 'run' });
    await fixture.storage.saveMemoryState(passive('walks').state);
    const system = new MemorySystemV2(fixture.storage, undefined, 'UTC');
    await system.finalizeHistoricalDates('u', 'UTC');
    assert.equal((await fixture.storage.getMemoryState('u', 'running'))!.fsrsReviews.length, 0);
    assert.equal((await fixture.storage.getMemoryState('u', 'run'))!.fsrsReviews.length, 1);
    const identities = new Map([['running', 'run'], ['run', 'run'], ['walks', 'walk']]);
    assert.deepEqual(await system.repairCanonicalRecallHistory('u', identities), ['run']);
    assert.equal((await fixture.storage.getMemoryState('u', 'run'))!.fsrsCard.reps, 0);
    assert.equal(await fixture.storage.getMemoryState('u', 'walk'), null);
    assert.deepEqual(await system.repairCanonicalRecallHistory('u', identities), []);
  } finally { fixture.restore(); }
});

test('recall journal recovery rebuilds a genuine rating without granting credit for an older passive Good', () => {
  const original = passive('recover');
  const attempt: ReadingVerificationEvidence = { userId: 'u', wordId: 'recover', attemptId: 'real:1',
    questionId: 'q', articleId: 'card', purpose: 'flashcard_review', rating: 1, outcome: 'incorrect',
    occurredAt: '2026-09-01T12:00:00Z', localDate: '2026-09-01', timezone: 'UTC' };
  const clean = replayVerificationEvidence(original.state, [attempt], 'UTC', [original.day], now)!;
  const expected = submitFsrsReview(original.baseline, 1, new Date(attempt.occurredAt));
  assert.deepEqual(clean.fsrsCard, expected.fsrsCard);
  assert.equal(clean.passiveReadingReviews?.length, 1);
  assert.deepEqual(clean.fsrsReviews[0].verificationAttemptIds, [attempt.attemptId]);
  assert.deepEqual(replayVerificationEvidence(clean, [attempt], 'UTC', [original.day], now), clean);
});

test('an old automatic Good alone cannot authorize a new word-card rating', async () => {
  const fixture = withBrowser();
  try {
    const original = passive('incidental');
    await fixture.storage.saveMemoryState(original.state);
    await fixture.storage.saveDailyEvidence(original.day);
    await assert.rejects(saveVerificationAttempt(fixture.storage, 'u', { wordId: 'incidental', attemptId: 'card:1',
      questionId: 'q', articleId: 'card', purpose: 'flashcard_review', rating: 3, outcome: 'recognized' }, 'UTC', now), /还没有查询或回忆记录/);
    assert.equal(await fixture.storage.getMeta('reading-verification:u'), null);
    assert.deepEqual(await fixture.storage.getMemoryState('u', 'incidental'), original.state);
  } finally { fixture.restore(); }
});
