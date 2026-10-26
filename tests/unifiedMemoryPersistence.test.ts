import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalLearningDatabase } from '../server/localDatabase/store';
import { validateLocalDataBackup, type LocalDataBackup } from '../src/lib/localDataBackup';
import { MEMORY_TABLES } from '../src/lib/localDatabaseProtocol';
import { importAndVerifyItem, parseMigrationItem } from '../src/lib/memoryV2/indexedDbImpl';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { readVerificationHistory } from '../src/lib/memoryV2/verificationMemory';
import type { ReadingVerificationEvidence } from '../src/lib/memoryV2/types';
import type { FlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';

const userId = 'isolated-unified-memory';
const at = '2026-10-24T04:00:00.000Z';
const journalKey = `reading-verification:${userId}`;
const storageKey = `english-ai:v2:memory:meta:${journalKey}`;
const policy = { version: 5 as const, desiredRetention: 0.93 };
const attempt = (attemptId: string, overrides: Partial<ReadingVerificationEvidence> = {}): ReadingVerificationEvidence => ({
  attemptId, wordId: 'remember', questionId: `reading:${attemptId}`, articleId: 'article',
  purpose: 'delayed_verification', outcome: 'recognized', userId, occurredAt: at,
  localDate: '2026-10-24', timezone: 'UTC', scheduling: policy, ...overrides,
});
const journal = (attempts: ReadingVerificationEvidence[]) => ({ version: 1, userId, attempts });
function backup(attempts: ReadingVerificationEvidence[], scheduling: FlashcardSchedulingPolicy = policy): LocalDataBackup {
  let state = submitFsrsReview(initializeWordMemory(userId, 'remember'), 3, new Date(at), scheduling);
  if (scheduling.version === 6) {
    state.fsrsCard.confirmationDue = '2026-10-25T04:00:00.000Z';
    Object.assign(state.fsrsReviews.at(-1)!, { readingTask: { type: 'context_choice', contextVisible: true,
      answerExposed: false, mapping: 'hard_on_correct' } });
    state = submitFsrsReview(state, 3, new Date('2026-10-24T04:00:30.000Z'), scheduling,
      { kind: 'answer_rehearsal', answerExposedAt: at });
    state.fsrsCard.confirmationDue = '2026-10-25T04:00:00.000Z';
    Object.assign(state.fsrsReviews.at(-1)!, { readingTask: { type: 'context_choice', contextVisible: true,
      answerExposed: true, mapping: 'practice_only' } });
  }
  Object.assign(state.fsrsReviews[0], { source: 'verification', verificationAttemptIds: [attempts[0].attemptId] });
  return { format: 'english-ai-local-backup', version: 1, exportedAt: at, memoryStorage: 'indexedDB',
    localStorage: { [storageKey]: JSON.stringify(journal(attempts)) },
    indexedDb: { name: 'english-ai-memory-v2', version: 1, stores: {
      ...Object.fromEntries(MEMORY_TABLES.map(table => [table, []])),
      memoryState: [{ key: `${userId}|remember`, state }], meta: [{ key: journalKey, value: journal(attempts) }],
    } } };
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
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function storage() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new BrowserStorage() } });
  return new LocalStorageMemoryStorage();
}
async function importJournal(target: LocalStorageMemoryStorage, attempts: ReadingVerificationEvidence[]) {
  const item = parseMigrationItem(storageKey, structuredClone(journal(attempts)));
  assert.ok(item);
  await importAndVerifyItem(target, item);
}

for (const version of [5, 6] as const) test(`Node SQLite preserves v${version} reading policies, review snapshots and policy-free history through restore and reopen`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-unified-memory-'));
  const filename = path.join(directory, 'learning.sqlite');
  let database = new LocalLearningDatabase(filename);
  t.after(async () => {
    database.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-unified-memory-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const scheduling = { version, desiredRetention: 0.93 };
  const source = backup([attempt('new-reading', { scheduling, ...(version === 6 ? { readingTask: {
    type: 'context_choice' as const, contextVisible: true as const, answerExposed: false, mapping: 'hard_on_correct' as const,
  } } : {}) }), attempt('legacy-reading', { scheduling: undefined })], scheduling);
  // JSON represents the persisted legacy shape with no field, rather than null.
  const expected = JSON.parse(JSON.stringify(source)) as LocalDataBackup;
  const profile = database.bootstrap(expected).profile;
  database.restore(profile.id, profile.revision, expected);
  database.close();
  database = new LocalLearningDatabase(filename);
  const restored = database.snapshot(profile.id);
  assert.deepEqual(restored.indexedDb?.stores.meta, expected.indexedDb?.stores.meta);
  assert.deepEqual(restored.indexedDb?.stores.memoryState, expected.indexedDb?.stores.memoryState);
  assert.deepEqual(restored.localStorage, expected.localStorage);
  if (version === 6) {
    const state = (restored.indexedDb!.stores.memoryState[0] as { state: ReturnType<typeof initializeWordMemory> }).state;
    assert.equal(state.fsrsCard.confirmationDue, '2026-10-25T04:00:00.000Z');
    assert.equal(state.fsrsReviews.at(-1)?.modelApplied, false);
    assert.deepEqual(state.fsrsReviews.at(-1)?.evidence, { kind: 'answer_rehearsal', answerExposedAt: at });
    assert.equal(state.fsrsReviews.at(-1)?.beforeCard?.confirmationDue, state.fsrsCard.confirmationDue);
  }
  const rows = restored.indexedDb!.stores.meta as Array<{ value: { attempts: ReadingVerificationEvidence[] } }>;
  assert.equal(Object.hasOwn(rows[0].value.attempts[1], 'scheduling'), false);
  for (const scheduling of [null, { version: 7, desiredRetention: 0.93 }, { version: 4, desiredRetention: 0.905 }]) {
    const corrupt = structuredClone(expected);
    (corrupt.indexedDb!.stores.meta[0] as any).value.attempts[0].scheduling = scheduling;
    assert.throws(() => database.restore(profile.id, database.profiles()[0].revision, corrupt), /记录无效/);
    assert.deepEqual(database.snapshot(profile.id).indexedDb?.stores, restored.indexedDb?.stores);
  }
});

test('backup and migration validators reject invalid reading policies in both current and legacy storage layouts', () => {
  for (const scheduling of [null, {}, { version: 7, desiredRetention: 0.93 }, { version: 4, desiredRetention: 0.905 },
    { version: 4, desiredRetention: '0.93' }]) {
    const row = { ...attempt('bad-reading'), scheduling } as unknown as ReadingVerificationEvidence;
    assert.throws(() => parseMigrationItem(storageKey, journal([row])), /Invalid reading verification journal/);
    const candidate = backup([row]);
    assert.throws(() => validateLocalDataBackup(candidate), /记录无效/);
    assert.throws(() => validateLocalDataBackup({ ...candidate, indexedDb: null, memoryStorage: 'localStorage' }), /记录无效/);
  }
});

test('v6 reading migration retains its frozen policy and legacy attempts without adding policy fields', async () => {
  const target = storage();
  const attempts = JSON.parse(JSON.stringify([attempt('v6-reading', { scheduling: { version: 6, desiredRetention: 0.93 } }),
    attempt('legacy-reading', { scheduling: undefined })])) as ReadingVerificationEvidence[];
  await importJournal(target, attempts);
  await importJournal(target, attempts);
  assert.deepEqual(await readVerificationHistory(new LocalStorageMemoryStorage(), userId), attempts);
});

for (const existingIndices of [[], [0, 1], [0, 2]]) {
  test(`v4 reading attempts preserve same-time source order with existing indices ${JSON.stringify(existingIndices)}`, async () => {
    const target = storage();
    const attempts = [attempt('z-first'), attempt('y-second'), attempt('a-third', { outcome: 'incorrect' })];
    if (existingIndices.length) await importJournal(target, existingIndices.map(index => attempts[index]));
    await importJournal(target, attempts);
    await importJournal(target, attempts);
    assert.deepEqual(await readVerificationHistory(new LocalStorageMemoryStorage(), userId), attempts);
  });
}

test('same-ID reading policy conflicts stop migration before replacing existing journal or state', async () => {
  for (const changedPolicy of [undefined, { version: 3 as const, desiredRetention: 0.93 }, { version: 4 as const, desiredRetention: 0.95 }]) {
    for (const reverse of [false, true]) {
      const target = storage();
      const pair = [attempt('same-reading'), attempt('same-reading', { scheduling: changedPolicy })];
      if (reverse) pair.reverse();
      await importJournal(target, [pair[0]]);
      const original = await target.getMeta(journalKey);
      const state = initializeWordMemory(userId, 'remember');
      await target.saveMemoryState(state);
      await assert.rejects(importJournal(target, [pair[1]]), /Conflicting reading scheduling policy/);
      assert.deepEqual(await target.getMeta(journalKey), original);
      assert.deepEqual(await target.getMemoryState(userId, 'remember'), state);
    }
  }
});

test('reading v4 contradictory same-time histories are rejected without overwriting the target', async () => {
  const target = storage();
  const attempts = [attempt('z-first'), attempt('a-second')];
  await importJournal(target, attempts);
  const before = await target.getMeta(journalKey);
  await assert.rejects(importJournal(target, [...attempts].reverse()), /Conflicting same-time/);
  assert.deepEqual(await target.getMeta(journalKey), before);
});

test('legacy reading attempts retain their policy-free shape and historical same-time ID ordering', async () => {
  const target = storage();
  const attempts = JSON.parse(JSON.stringify([attempt('z-first', { scheduling: undefined }),
    attempt('a-second', { scheduling: undefined })])) as ReadingVerificationEvidence[];
  await importJournal(target, attempts);
  const restored = await readVerificationHistory(target, userId);
  assert.deepEqual(restored.map(row => row.attemptId), ['a-second', 'z-first']);
  assert.ok(restored.every(row => !Object.hasOwn(row, 'scheduling')));
});

test('same reading review audit cannot be merged under a different frozen scheduling policy', async () => {
  const target = storage();
  const state = submitFsrsReview(initializeWordMemory(userId, 'remember'), 3, new Date(at), policy);
  Object.assign(state.fsrsReviews[0], { source: 'verification', verificationAttemptIds: ['same-reading'] });
  await target.saveMemoryState(state);
  const changed = structuredClone(state);
  changed.fsrsReviews[0].scheduling = { ...policy, desiredRetention: 0.95 };
  const item = parseMigrationItem(`english-ai:v2:memory:state:${userId}:remember`, changed);
  assert.ok(item);
  await assert.rejects(importAndVerifyItem(target, item), /Conflicting reading scheduling policy/);
  assert.deepEqual(await target.getMemoryState(userId, 'remember'), state);
});
