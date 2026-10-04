import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import type { ReadingVerificationInput } from '../src/lib/memoryV2/types';
import { exportLocalDataBackup, importLocalDataBackup, validateLocalDataBackup,
  MEMORY_IDB_NAME, MEMORY_IDB_VERSION } from '../src/lib/localDataBackup';

class BrowserStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function setup(browser = new BrowserStorage()) {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: browser }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  return { browser, storage, system: new MemorySystemV2(storage, undefined, 'Asia/Shanghai') };
}

const firstAt = new Date('2026-09-03T15:59:59.000Z');
const sentence = 'Theo will run the garden centre while its director is away.';
function answer(overrides: Partial<ReadingVerificationInput> = {}): ReadingVerificationInput {
  return { attemptId: 'generated-attempt-1', questionId: 'reading-verification.llm.v1:run:fixed-content-id',
    wordId: 'run', articleId: 'article-1', outcome: 'recognized', selectedOptionId: 'A',
    questionSentence: sentence, ...overrides };
}

test('generated question sentences persist through a memory-system reopen and history returns detached records', async () => {
  const { system, storage } = setup();
  await system.recordVerification('u', answer(), firstAt);
  const reopened = new MemorySystemV2(storage, undefined, 'Asia/Shanghai');
  const history = await reopened.getVerificationHistory('u');
  assert.equal(history.length, 1);
  assert.equal(history[0].questionSentence, sentence);
  assert.equal(history[0].occurredAt, firstAt.toISOString());
  assert.equal(history[0].localDate, '2026-09-03');
  assert.equal(history[0].timezone, 'Asia/Shanghai');
  assert.deepEqual(await reopened.getVerificationHistory('another-user'), []);
  history[0].questionSentence = 'A caller changed this local copy.';
  assert.equal((await reopened.getVerificationHistory('u'))[0].questionSentence, sentence);
});

test('retries retain the original sentence and timestamp and reject a changed frozen question identity', async () => {
  const { system, storage } = setup();
  await system.recordVerification('u', answer(), firstAt);
  const originalState = await storage.getMemoryState('u', 'run');
  const originalHistory = await system.getVerificationHistory('u');
  const later = new Date('2026-09-03T16:10:00.000Z');
  await system.recordVerification('u', answer(), later);
  await system.recordVerification('u', answer({ questionSentence: undefined }), later);
  assert.deepEqual(await system.getVerificationHistory('u'), originalHistory);
  assert.deepEqual((await storage.getMemoryState('u', 'run'))!.fsrsReviews, originalState!.fsrsReviews);
  for (const change of [{ questionSentence: 'Nora will run a different shop when its manager is away.' },
    { questionId: 'different-question' }, { wordId: 'bank' }, { articleId: 'different-article' },
    { selectedOptionId: 'B' }]) {
    await assert.rejects(system.recordVerification('u', answer(change), later), /冲突/);
    assert.deepEqual(await system.getVerificationHistory('u'), originalHistory);
    assert.deepEqual((await storage.getMemoryState('u', 'run'))!.fsrsReviews, originalState!.fsrsReviews);
  }
  await system.recordVerification('u', answer({ outcome: 'guessed' }), later);
  const corrected = (await system.getVerificationHistory('u'))[0];
  assert.equal(corrected.questionSentence, sentence);
  assert.equal(corrected.occurredAt, firstAt.toISOString());
  assert.equal(corrected.localDate, '2026-09-03');
  assert.equal(corrected.outcome, 'guessed');
});

test('legacy attempts may omit the sentence, while invalid optional sentences reject before durable writes', async () => {
  const { system, storage } = setup();
  const legacy = answer({ questionSentence: undefined, outcome: 'skipped', selectedOptionId: undefined });
  await system.recordVerification('u', legacy, firstAt);
  assert.equal((await system.getVerificationHistory('u'))[0].questionSentence, undefined);
  const before = await system.getVerificationHistory('u');
  for (const value of ['', '   ', 'x'.repeat(501), 123, null]) {
    await assert.rejects(system.recordVerification('u', { ...answer({ attemptId: 'invalid-attempt' }),
      questionSentence: value } as ReadingVerificationInput, firstAt), /Invalid question sentence/);
    assert.deepEqual(await system.getVerificationHistory('u'), before);
  }
  assert.equal(await storage.getMemoryState('u', 'run'), null);
});

test('a derived-state crash keeps the generated context in the durable journal for recovery', async () => {
  const { system, storage } = setup();
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('interrupted state write'); };
  await assert.rejects(system.recordVerification('u', answer(), firstAt), /interrupted/);
  assert.equal((await system.getVerificationHistory('u'))[0].questionSentence, sentence);
  storage.saveMemoryState = save;
  const reopened = new MemorySystemV2(storage, undefined, 'Asia/Shanghai');
  await reopened.finalizeHistoricalDates('u', 'Asia/Shanghai');
  assert.equal((await reopened.getVerificationHistory('u'))[0].questionSentence, sentence);
  assert.equal((await storage.getMemoryState('u', 'run'))!.fsrsReviews.length, 1);
});

test('local-data backup export and import restore sentence metadata and its frozen history', async () => {
  const { system } = setup();
  await system.recordVerification('u', answer(), firstAt);
  const expectedHistory = await system.getVerificationHistory('u');
  const exported = await exportLocalDataBackup();
  const backup = validateLocalDataBackup(JSON.parse(JSON.stringify(exported)));
  const metadataKey = Object.keys(backup.localStorage).find((key) => key.includes(':meta:reading-verification:u'))!;
  assert.ok(metadataKey);
  assert.equal(JSON.parse(backup.localStorage[metadataKey]).attempts[0].questionSentence, sentence);
  const replacement = new BrowserStorage();
  replacement.setItem('unrelated-app', 'keep this value');
  const { system: restored, storage } = setup(replacement);
  await importLocalDataBackup({ ...backup, indexedDb: null });
  assert.deepEqual(await restored.getVerificationHistory('u'), expectedHistory);
  assert.equal(replacement.getItem('unrelated-app'), 'keep this value');
  assert.equal((await storage.getMemoryState('u', 'run'))!.fsrsReviews.length, 1);
});

test('backup validation preserves generated question sentences in IndexedDB meta rows', async () => {
  const { system, storage } = setup();
  await system.recordVerification('u', answer(), firstAt);
  const journal = await storage.getMeta('reading-verification:u');
  const exported = await exportLocalDataBackup();
  const backup = validateLocalDataBackup(JSON.parse(JSON.stringify({ ...exported,
    indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION,
      stores: { meta: [{ key: 'reading-verification:u', value: journal }] } } })));
  assert.deepEqual(backup.indexedDb!.stores.meta, [{ key: 'reading-verification:u', value: journal }]);
});
