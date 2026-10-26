import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { importAndVerifyItem, parseMigrationItem } from '../src/lib/memoryV2/indexedDbImpl';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { aggregateDailyEvidence } from '../src/lib/memoryV2/evidenceAggregation';
import type { WordJournal } from '../src/lib/browserExtension/replay';
import type { ArticleWordEvidence, ReadingVerificationEvidence, WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function setup() {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  return new LocalStorageMemoryStorage();
}
const balanced = { version: 1 as const, desiredRetention: 0.93 };
const intensive = { version: 1 as const, desiredRetention: 0.95 };
const at = new Date('2026-10-01T12:00:00.000Z');
function empty(): WordMemoryState {
  const state = initializeWordMemory('schedule-migration', 'learn');
  state.nextReview = state.fsrsCard.due = at.toISOString();
  return state;
}
function flashcard(state: WordMemoryState, rating: 1 | 2 | 3 | 4, when: Date, attemptId: string, policy = balanced) {
  const updated = submitFsrsReview(state, rating, when, policy);
  updated.fsrsReviews.at(-1)!.source = 'flashcard';
  updated.fsrsReviews.at(-1)!.verificationAttemptIds = [attemptId];
  return updated;
}

test('migration refuses changing one recall policy, including a legacy recall reinterpreted as short-term', async () => {
  const storage = setup();
  const attempt: ReadingVerificationEvidence = { attemptId: 'one-recall', questionId: 'flashcard:learn',
    wordId: 'learn', articleId: 'flashcards', outcome: 'recognized', purpose: 'flashcard_review', rating: 3,
    occurredAt: at.toISOString(), localDate: '2026-10-01', timezone: 'UTC', userId: 'schedule-migration', scheduling: balanced };
  const key = 'reading-verification:schedule-migration';
  await storage.setMeta(key, { version: 1, userId: attempt.userId, attempts: [attempt] });
  for (const policy of [intensive, undefined]) {
    const incoming = { ...attempt, scheduling: policy };
    await assert.rejects(importAndVerifyItem(storage, { kind: 'meta', key,
      value: { version: 1, userId: attempt.userId, attempts: [incoming] } }), /scheduling policy/);
    assert.deepEqual((await storage.getMeta<{ attempts: ReadingVerificationEvidence[] }>(key))!.attempts, [attempt]);
  }
});

test('merging review branches replays every saved policy and refreshes exact short-term input snapshots', async () => {
  const storage = setup();
  const first = flashcard(empty(), 3, at, 'first');
  const secondAt = new Date(first.nextReview);
  const main = flashcard(first, 3, secondAt, 'second');
  const thirdAt = new Date(secondAt.getTime() + 60_000);
  const incoming = flashcard(first, 1, thirdAt, 'third', intensive);
  await storage.saveMemoryState(main);
  await importAndVerifyItem(storage, { kind: 'state', value: incoming });
  const merged = (await storage.getMemoryState(main.userId, main.wordId))!;
  const expected = flashcard(main, 1, thirdAt, 'third', intensive);
  assert.deepEqual(merged.fsrsCard, expected.fsrsCard);
  assert.equal(merged.fsrsCard.lapses, 1);
  assert.deepEqual(merged.fsrsReviews.map(review => review.scheduling), [balanced, balanced, intensive]);
  assert.deepEqual(merged.fsrsReviews[2].beforeCard, main.fsrsCard);
  await importAndVerifyItem(storage, { kind: 'state', value: incoming });
  assert.deepEqual((await storage.getMemoryState(main.userId, main.wordId))!.fsrsCard, expected.fsrsCard);
});

test('merging lookup-only snapshots preserves a known legacy failure while retaining the assistance count', async () => {
  const storage = setup();
  const legacy: ArticleWordEvidence = { userId: 'schedule-migration', wordId: 'learn', articleId: 'article',
    localDate: '2026-10-01', validExposureCount: 0, clickedOccurrenceCount: 1,
    firstSeenAt: at.toISOString(), lastSeenAt: at.toISOString() };
  await storage.saveArticleEvidence(legacy);
  const incoming = { ...legacy, clickedOccurrenceCount: 2, recallFailureCount: 0 };
  await importAndVerifyItem(storage, { kind: 'article', value: incoming });
  const saved = (await storage.getArticleEvidence(legacy.userId, legacy.wordId, legacy.articleId, legacy.localDate))!;
  assert.equal(saved.clickedOccurrenceCount, 2);
  assert.equal(saved.recallFailureCount, 1);
  const daily = aggregateDailyEvidence([saved])!;
  assert.equal(daily.pendingGrade, 'Again');
  assert.equal(daily.recallFailureCount, 1);
});

test('migration preserves the chosen retention preference and rejects invalid retention values', async () => {
  const storage = setup();
  const key = 'flashcard-study-preferences:schedule-migration';
  const current = { version: 1, userId: 'schedule-migration', dailyNewWordLimit: 10,
    desiredRetention: 0.95, autoSpeakCount: 2, importedWordIds: ['learn'], aliasBaselines: [], updatedAt: '2026-10-02T12:00:00.000Z' };
  await storage.setMeta(key, current);
  const older = { ...current, desiredRetention: 0.9, importedWordIds: ['remember'], updatedAt: at.toISOString() };
  await importAndVerifyItem(storage, { kind: 'meta', key, value: older });
  const saved = await storage.getMeta<typeof current>(key);
  assert.equal(saved!.desiredRetention, 0.95);
  assert.equal(saved!.autoSpeakCount, 2);
  assert.deepEqual(saved!.importedWordIds, ['learn', 'remember']);
  for (const desiredRetention of [0.79, 0.98, 0.935, '0.93']) {
    assert.throws(() => parseMigrationItem(`english-ai:v2:memory:meta:${key}`, { ...current, desiredRetention }), /Invalid flashcard study preferences/);
  }
});

test('migration retains pending failure recovery markers from both journal copies', async () => {
  const storage = setup();
  const key = 'extension-journal:' + JSON.stringify(['schedule-migration', 'learn']);
  const existing: WordJournal = { version: 1, userId: 'schedule-migration', wordId: 'learn',
    baselineState: null, baselineDaily: [], baselineRaw: [], events: [],
    pendingFailureDates: ['2026-10-01'] };
  await storage.setMeta(key, existing);
  const incoming: WordJournal = { ...existing, pendingFailureDates: ['2026-10-02', '2026-10-01'] };
  await importAndVerifyItem(storage, { kind: 'meta', key, value: incoming });
  const saved = (await storage.getMeta<WordJournal>(key))!;
  assert.deepEqual(saved.pendingFailureDates, ['2026-10-01', '2026-10-02']);
  await importAndVerifyItem(storage, { kind: 'meta', key, value: { ...incoming, pendingFailureDates: undefined } });
  assert.deepEqual((await storage.getMeta<WordJournal>(key))!.pendingFailureDates, saved.pendingFailureDates);
});
