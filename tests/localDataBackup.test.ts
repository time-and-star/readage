import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  applyAppLocalStorage,
  collectAppLocalStorage,
  isAppStorageKey,
  LOCAL_BACKUP_FORMAT,
  LOCAL_BACKUP_VERSION,
  validateLocalDataBackup,
  importLocalDataBackup,
  exportLocalDataBackup,
  getLocalDataBackupWarning,
  MEMORY_IDB_NAME,
  MEMORY_IDB_VERSION,
} from '../src/lib/localDataBackup';
import { updatePersistentValue } from '../src/lib/storage';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';

const globalDescriptors = new Map(['window', 'navigator', 'indexedDB'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
afterEach(() => {
  for (const [key, descriptor] of globalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const storeNames = ['rawEvents', 'articleEvidence', 'dailyEvidence', 'memoryState', 'finalizationTasks', 'meta'];
function memoryRow(wordId = 'run', userId = 'u') {
  const state = initializeWordMemory(userId, wordId);
  state.nextReview = state.fsrsCard.due = '2026-09-01T12:00:00.000Z';
  return { key: `${userId}|${wordId}`, state };
}
class FakeIndexedDb {
  stores: Record<string, unknown[]> = Object.fromEntries(storeNames.map(name => [name, []]));
  failOpen = false;
  failRead = false;
  failNextWrite = false;
  opened = 0;
  open() {
    this.opened += 1;
    const request: any = {};
    queueMicrotask(() => {
      if (this.failOpen) { request.error = new Error('database unavailable'); request.onerror?.(); return; }
      request.result = { version: MEMORY_IDB_VERSION, objectStoreNames: storeNames, close() {},
        transaction: (_names: string[], mode: string) => this.transaction(mode) };
      request.onsuccess?.();
    });
    return request;
  }
  private transaction(mode: string) {
    const staged = structuredClone(this.stores);
    let stopped = false;
    const tx: any = { abort() { stopped = true; queueMicrotask(() => tx.onabort?.()); },
      objectStore: (name: string) => ({
        getAll: () => {
          const request: any = {};
          queueMicrotask(() => {
            if (this.failRead) {
              stopped = true; request.error = tx.error = new Error('read unavailable');
              request.onerror?.(); tx.onerror?.();
            } else { request.result = structuredClone(staged[name]); request.onsuccess?.(); }
          });
          return request;
        },
        clear: () => { staged[name] = []; },
        put: (row: unknown) => {
          if (this.failNextWrite) { this.failNextWrite = false; throw new Error('quota'); }
          staged[name].push(structuredClone(row));
        },
      }) };
    setImmediate(() => {
      if (stopped) return;
      if (mode === 'readwrite') this.stores = staged;
      tx.oncomplete?.();
    });
    return tx;
  }
}
function installBrowser(storage = new MemoryStorage(), factory?: FakeIndexedDb) {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: storage }, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: async (_name: string, work: () => unknown) => work() } }, configurable: true });
  if (factory) Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true });
  else Reflect.deleteProperty(globalThis, 'indexedDB');
  return storage;
}

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test('isAppStorageKey only accepts english-ai:v2 namespace', () => {
  assert.equal(isAppStorageKey('english-ai:v2:articles'), true);
  assert.equal(isAppStorageKey('english-ai:v2'), true);
  assert.equal(isAppStorageKey('english-ai:v2:memory:raw:default-user:x:2026-01-01'), true);
  assert.equal(isAppStorageKey('other-app:data'), false);
  assert.equal(isAppStorageKey('english-ai:v1:articles'), false);
});

test('collect and apply localStorage backup round-trips app keys only', () => {
  const storage = new MemoryStorage();
  storage.setItem('english-ai:v2:articles', '[{"id":"a1"}]');
  storage.setItem('english-ai:v2:events', '[]');
  storage.setItem('unrelated', 'keep-me');

  const collected = collectAppLocalStorage(storage);
  assert.deepEqual(Object.keys(collected).sort(), [
    'english-ai:v2:articles',
    'english-ai:v2:events',
  ]);
  assert.equal(collected['english-ai:v2:articles'], '[{"id":"a1"}]');

  const other = new MemoryStorage();
  other.setItem('english-ai:v2:old', 'gone');
  other.setItem('unrelated', 'keep-me');
  const result = applyAppLocalStorage(collected, other);
  assert.equal(result.written, 2);
  assert.equal(result.removed, 1);
  assert.equal(other.getItem('english-ai:v2:articles'), '[{"id":"a1"}]');
  assert.equal(other.getItem('english-ai:v2:old'), null);
  assert.equal(other.getItem('unrelated'), 'keep-me');
});

test('validateLocalDataBackup accepts v1 payload and rejects foreign formats', () => {
  const valid = validateLocalDataBackup({
    format: LOCAL_BACKUP_FORMAT,
    version: LOCAL_BACKUP_VERSION,
    exportedAt: '2026-07-25T00:00:00.000Z',
    localStorage: {
      'english-ai:v2:articles': '[]',
      'ignored-key': 'nope',
    },
    indexedDb: null,
  });
  assert.equal(valid.format, LOCAL_BACKUP_FORMAT);
  assert.deepEqual(valid.localStorage, { 'english-ai:v2:articles': '[]' });

  assert.throws(
    () => validateLocalDataBackup({ format: 'other', version: 1, localStorage: {} }),
    /不是本应用/
  );
  assert.throws(
    () =>
      validateLocalDataBackup({
        format: LOCAL_BACKUP_FORMAT,
        version: 99,
        localStorage: {},
      }),
    /不支持的备份版本/
  );
});

test('import restores the previous localStorage namespace when replacement fails', async () => {
  const storage = new MemoryStorage();
  storage.setItem('english-ai:v2:articles', 'old');
  let writes = 0;
  const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes += 1;
    if (writes === 2) throw new Error('quota');
    originalSetItem(key, value);
  };
  installBrowser(storage);

  await assert.rejects(
    importLocalDataBackup({
      format: LOCAL_BACKUP_FORMAT,
      version: LOCAL_BACKUP_VERSION,
      localStorage: {
        'english-ai:v2:articles': 'new',
        'english-ai:v2:events': 'new-events',
      },
      indexedDb: null,
    }),
    /quota/
  );
  assert.equal(storage.getItem('english-ai:v2:articles'), 'old');
  assert.equal(storage.getItem('english-ai:v2:events'), null);
  delete (globalThis as { window?: unknown }).window;
});

test('an unavailable IndexedDB API exports explicitly complete localStorage memory', async () => {
  const storage = installBrowser();
  storage.setItem('english-ai:v2:memory:state:default-user:run', '{"wordId":"run"}');
  const backup = await exportLocalDataBackup();
  assert.equal(backup.memoryStorage, 'localStorage');
  assert.equal(backup.indexedDb, null);
  assert.ok(backup.localStorage['english-ai:v2:memory:state:default-user:run']);
  assert.equal(getLocalDataBackupWarning(backup), null);
});

test('export refuses unsaved optimistic records and includes them after the same write is retried', async () => {
  const storage = installBrowser();
  const key = 'english-ai:v2:backup-integrity-test';
  const setItem = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = (entryKey, value) => { if (entryKey === key && fail) throw new Error('quota'); setItem(entryKey, value); };
  const update = updatePersistentValue<string[]>(key, [], previous => [...previous, 'latest-learning-record']).catch(() => undefined);
  await assert.rejects(exportLocalDataBackup(), /学习记录尚未全部保存/);
  await update;
  fail = false;
  const backup = await exportLocalDataBackup();
  assert.deepEqual(JSON.parse(backup.localStorage[key]), ['latest-learning-record']);
});

test('IndexedDB open and read failures stop export rather than downloading an incomplete backup', async () => {
  for (const failure of ['failOpen', 'failRead'] as const) {
    const factory = new FakeIndexedDb();
    factory[failure] = true;
    const storage = installBrowser(undefined, factory);
    storage.setItem('english-ai:v2:articles', 'current');
    await assert.rejects(exportLocalDataBackup(), /词汇记忆库读取失败/);
    assert.equal(storage.getItem('english-ai:v2:articles'), 'current');
  }
});

test('an explicitly active localStorage backend does not mistake unavailable IndexedDB for its own memory', async () => {
  const factory = new FakeIndexedDb();
  factory.failOpen = true;
  const storage = installBrowser(undefined, factory);
  storage.setItem('english-ai:v2:memory:meta', 'local-memory');
  const backup = await exportLocalDataBackup({ memoryStorage: 'localStorage' });
  assert.equal(factory.opened, 0);
  assert.equal(backup.memoryStorage, 'localStorage');
  assert.equal(backup.localStorage['english-ai:v2:memory:meta'], 'local-memory');
});

test('complete IndexedDB memory and metadata round-trip without retaining target records', async () => {
  const source = new FakeIndexedDb();
  source.stores.memoryState = [memoryRow()];
  source.stores.meta = [{ key: 'preferences', value: { dailyNewWordLimit: 0 } }, { key: 'nullable', value: null }];
  const storage = installBrowser(undefined, source);
  storage.setItem('english-ai:v2:articles', 'source');
  const backup = await exportLocalDataBackup({ memoryStorage: 'indexedDB' });
  assert.equal(backup.memoryStorage, 'indexedDB');
  const target = new FakeIndexedDb();
  target.stores.memoryState = [memoryRow('other')];
  installBrowser(storage, target);
  storage.setItem('english-ai:v2:articles', 'target');
  await importLocalDataBackup(backup);
  assert.deepEqual(target.stores, source.stores);
  assert.equal(storage.getItem('english-ai:v2:articles'), 'source');
});

test('a legacy backup without memory cannot overwrite an existing target memory library', async () => {
  const factory = new FakeIndexedDb();
  factory.stores.memoryState = [memoryRow()];
  const before = structuredClone(factory.stores);
  const storage = installBrowser(undefined, factory);
  storage.setItem('english-ai:v2:articles', 'target');
  const backup = { format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
    localStorage: { 'english-ai:v2:articles': 'source' }, indexedDb: null };
  assert.match(getLocalDataBackupWarning(validateLocalDataBackup(backup))!, /旧版备份/);
  await assert.rejects(importLocalDataBackup(backup), /旧备份未包含/);
  assert.deepEqual(factory.stores, before);
  assert.equal(storage.getItem('english-ai:v2:articles'), 'target');
});

test('legacy history can restore to an otherwise empty target with only storage initialization metadata', async () => {
  const factory = new FakeIndexedDb();
  factory.stores.meta = [{ key: 'localStorageMigratedV1', value: { status: 'completed' } }];
  const storage = installBrowser(undefined, factory);
  await importLocalDataBackup({ format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
    localStorage: { 'english-ai:v2:articles': 'source' }, indexedDb: null });
  assert.equal(storage.getItem('english-ai:v2:articles'), 'source');
  assert.ok(Object.values(factory.stores).every(rows => rows.length === 0));
});

test('localStorage memory restoration clears target IndexedDB so startup cannot mix the two libraries', async () => {
  const factory = new FakeIndexedDb();
  factory.stores.memoryState = [memoryRow('other')];
  const storage = installBrowser(undefined, factory);
  await importLocalDataBackup({ format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
    memoryStorage: 'localStorage', localStorage: { 'english-ai:v2:memory:state:user:run': '{"wordId":"run"}' }, indexedDb: null });
  assert.ok(Object.values(factory.stores).every(rows => rows.length === 0));
  assert.ok(storage.getItem('english-ai:v2:memory:state:user:run'));
});

test('restoration write failures roll back both memory and browser history', async () => {
  const factory = new FakeIndexedDb();
  factory.stores.memoryState = [memoryRow('other')];
  const before = structuredClone(factory.stores);
  const storage = installBrowser(undefined, factory);
  storage.setItem('english-ai:v2:articles', 'target');
  const stores = Object.fromEntries(storeNames.map(name => [name, [] as unknown[]]));
  stores.memoryState = [memoryRow()];
  factory.failNextWrite = true;
  await assert.rejects(importLocalDataBackup({ format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
    memoryStorage: 'indexedDB', localStorage: { 'english-ai:v2:articles': 'source' },
    indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores } }), /quota/);
  assert.deepEqual(factory.stores, before);
  assert.equal(storage.getItem('english-ai:v2:articles'), 'target');
});

test('a history write failure after memory replacement restores both original libraries', async () => {
  const factory = new FakeIndexedDb();
  factory.stores.memoryState = [memoryRow('other')];
  const before = structuredClone(factory.stores);
  const storage = installBrowser(undefined, factory);
  storage.setItem('english-ai:v2:articles', 'target');
  const setItem = storage.setItem.bind(storage);
  let writes = 0;
  storage.setItem = (key, value) => { if (++writes === 2) throw new Error('quota'); setItem(key, value); };
  await assert.rejects(importLocalDataBackup({ format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
    memoryStorage: 'localStorage', localStorage: { 'english-ai:v2:articles': 'source', 'english-ai:v2:events': '[]' }, indexedDb: null }), /quota/);
  assert.deepEqual(factory.stores, before);
  assert.equal(storage.getItem('english-ai:v2:articles'), 'target');
  assert.equal(storage.getItem('english-ai:v2:events'), null);
});

test('restore stops before changing history if the target memory library cannot be read', async () => {
  const factory = new FakeIndexedDb();
  factory.failRead = true;
  const storage = installBrowser(undefined, factory);
  storage.setItem('english-ai:v2:articles', 'target');
  await assert.rejects(importLocalDataBackup({ format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
    memoryStorage: 'localStorage', localStorage: { 'english-ai:v2:articles': 'source' }, indexedDb: null }), /读取失败/);
  assert.equal(storage.getItem('english-ai:v2:articles'), 'target');
});

test('missing stores and invalid memory rows are rejected before any destructive restoration', () => {
  const backup = { format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION, localStorage: {},
    indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores: {} } };
  assert.throws(() => validateLocalDataBackup(backup), /备份不完整/);
  const stores = Object.fromEntries(storeNames.map(name => [name, [] as unknown[]]));
  stores.memoryState = [{ value: {} }];
  assert.throws(() => validateLocalDataBackup({ ...backup, indexedDb: { ...backup.indexedDb, stores } }), /无效或重复/);
});

test('invalid memory wrappers, identities and unreadable FSRS records stop before browser replacement', async () => {
  const reviewed = submitFsrsReview(memoryRow().state, 3, new Date('2026-09-02T12:00:00.000Z'));
  const state = (changes: Record<string, unknown>) => ({ key: 'u|run', state: { ...structuredClone(reviewed), ...changes } });
  const mutations: Array<[string, unknown]> = [
    ['memoryState', { key: 'u|run' }], ['memoryState', { key: 'u|run', state: null }],
    ['memoryState', { key: 'u|run', state: [] }], ['memoryState', state({ wordId: 'another' })],
    ['memoryState', state({ fsrsCard: {} })], ['memoryState', state({ fsrsCard: { ...reviewed.fsrsCard, state: 99 } })],
    ['memoryState', state({ fsrsReviews: [null] })], ['memoryState', state({ fsrsReviews: [3] })],
    ['memoryState', state({ fsrsReviews: [{ ...reviewed.fsrsReviews[0], rating: 0 }] })],
    ['memoryState', state({ nextReview: '2026-02-31T00:00:00Z' })],
    ['memoryState', state({ rme: { exposureHistory: [null] } })],
    ['rawEvents', { key: 'u|run|2026-09-02', events: null }],
    ['rawEvents', { key: 'u|run|2026-09-02', events: [null] }],
    ['articleEvidence', { key: 'u|run|a|2026-09-02', evidence: [] }],
    ['dailyEvidence', { key: 'u|run|2026-09-02', evidence: null }],
    ['finalizationTasks', { key: 'u|2026-09-02', task: null }], ['meta', { key: 'missing-value' }],
  ];
  const factory = new FakeIndexedDb();
  factory.stores.memoryState = [memoryRow('existing')];
  const previous = structuredClone(factory.stores);
  const storage = installBrowser(undefined, factory);
  storage.setItem('english-ai:v2:articles', 'existing history');
  for (const [table, row] of mutations) {
    const stores = Object.fromEntries(storeNames.map(name => [name, [] as unknown[]]));
    stores[table] = [row];
    await assert.rejects(importLocalDataBackup({ format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
      memoryStorage: 'indexedDB', localStorage: { 'english-ai:v2:articles': 'replacement' },
      indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores } }), /记录无效/);
    assert.deepEqual(factory.stores, previous);
    assert.equal(storage.getItem('english-ai:v2:articles'), 'existing history');
  }
  assert.equal(factory.opened, 0, 'invalid payloads fail before touching the target memory database');
});

test('historical optional FSRS fields and null RME remain readable and round-trip unchanged', async () => {
  const source = new FakeIndexedDb();
  const row = memoryRow();
  const state = submitFsrsReview(row.state, 3, new Date('2026-09-02T09:00:00+08:00'));
  delete (state.fsrsCard as Partial<typeof state.fsrsCard>).learningSteps;
  state.fsrsReviews.forEach(review => { delete (review as Partial<typeof review>).learningSteps; });
  source.stores.memoryState = [{ ...row, state: { ...state, rme: null, futureField: { preserved: true } } }];
  source.stores.meta = [{ key: 'nullable', value: null }, { key: 'generic', value: ['old', 1] }];
  const storage = installBrowser(undefined, source);
  const backup = await exportLocalDataBackup({ memoryStorage: 'indexedDB' });
  const target = new FakeIndexedDb(); installBrowser(storage, target);
  await importLocalDataBackup(backup);
  assert.deepEqual(target.stores, source.stores);
  assert.ok(submitFsrsReview(state, 3, new Date('2026-09-03T12:00:00Z')).fsrsReviews.length > state.fsrsReviews.length);
});

test('scheduling audit and before-card snapshots round-trip while malformed new fields stop before browser access', async () => {
  const fresh = memoryRow().state;
  const reviewed = submitFsrsReview(fresh, 3, new Date('2026-09-02T12:00:00Z'));
  const review = { ...reviewed.fsrsReviews[0], scheduling: { version: 1, desiredRetention: 0.95 }, beforeCard: fresh.fsrsCard };
  const stores = Object.fromEntries(storeNames.map(name => [name, [] as unknown[]]));
  stores.memoryState = [{ key: 'u|run', state: { ...reviewed, fsrsReviews: [review] } }];
  const backup = { format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION, memoryStorage: 'indexedDB', localStorage: {},
    indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores } };
  assert.deepEqual(validateLocalDataBackup(backup).indexedDb?.stores, stores);
  const invalidReviews = [
    ...[null, {}, { version: 7, desiredRetention: 0.95 }, { version: 1, desiredRetention: 0.99 },
      { version: 1, desiredRetention: 0.905 }, { version: 1, desiredRetention: '0.95' }].map(scheduling => ({ ...review, scheduling })),
    ...[null, {}, { ...fresh.fsrsCard, stability: Infinity }, { ...fresh.fsrsCard, reps: -1 },
      { ...fresh.fsrsCard, lapses: 0.5 }, { ...fresh.fsrsCard, learningSteps: -1 },
      { ...fresh.fsrsCard, state: 2 }, { ...fresh.fsrsCard, state: 99 },
      { ...fresh.fsrsCard, due: 'invalid' }, { ...fresh.fsrsCard, lastReview: null }].map(beforeCard => ({ ...review, beforeCard })),
  ];
  const factory = new FakeIndexedDb(); installBrowser(undefined, factory);
  for (const invalidReview of invalidReviews) {
    const candidate = structuredClone(backup);
    candidate.indexedDb.stores.memoryState = [{ key: 'u|run', state: { ...reviewed, fsrsReviews: [invalidReview] } }];
    await assert.rejects(importLocalDataBackup(candidate), /记录无效/);
  }
  assert.equal(factory.opened, 0);
});

for (const version of [3, 4] as const) test(`policy v${version} learning and relearning states survive browser backups with due dates, steps and journals intact`, async () => {
  const scheduling = { version, desiredRetention: 0.93 };
  const at = new Date('2026-09-02T12:00:00.000Z');
  const learning = submitFsrsReview(memoryRow('learning').state, 3, at, scheduling);
  const review = submitFsrsReview(memoryRow('relearning').state, 3, new Date('2026-09-01T12:00:00.000Z'));
  const relearning = submitFsrsReview(review, 1, at, scheduling);
  const states = [learning, relearning];
  assert.equal(learning.fsrsCard.state, 1);
  assert.equal(relearning.fsrsCard.state, 3);
  assert.ok(states.every(state => Date.parse(state.nextReview) - at.getTime() < 86_400_000));
  if (version === 4) for (const state of states) assert.equal(state.nextReview, state.lastReview);
  assert.ok(learning.fsrsCard.learningSteps > 0);
  const source = new FakeIndexedDb();
  source.stores.memoryState = states.map(state => ({ key: `u|${state.wordId}`, state }));
  source.stores.meta = [
    { key: 'reading-verification:u', value: { version: 1, userId: 'u', attempts: states.map(state => ({
      attemptId: `card:${state.wordId}`, wordId: state.wordId, scheduling,
    })) } },
    { key: 'extension-journal:["u","learning"]', value: { version: 1, userId: 'u', wordId: 'learning',
      baselineState: learning, baselineDaily: [], baselineRaw: [], events: [] } },
  ];
  const localStorage = Object.fromEntries(states.map(state => [`english-ai:v2:memory:state:u:${state.wordId}`, JSON.stringify(state)]));
  const storage = installBrowser(undefined, source);
  applyAppLocalStorage(localStorage);
  const backup = await exportLocalDataBackup({ memoryStorage: 'indexedDB' });
  const target = new FakeIndexedDb(); installBrowser(storage, target);
  await importLocalDataBackup(backup);
  assert.deepEqual(target.stores, source.stores);
  assert.deepEqual(collectAppLocalStorage(), localStorage);
  const legacyBackup = { ...backup, memoryStorage: 'localStorage' as const, indexedDb: null,
    localStorage: { ...localStorage,
      'english-ai:v2:memory:meta:reading-verification:u': JSON.stringify((source.stores.meta[0] as any).value),
      'english-ai:v2:memory:meta:extension-journal:["u","learning"]': JSON.stringify((source.stores.meta[1] as any).value) } };
  assert.deepEqual(validateLocalDataBackup(legacyBackup).localStorage, legacyBackup.localStorage);
});

test('v6 browser backups preserve mixed policies, FSRS due dates and both journal storage layouts', async () => {
  let state = submitFsrsReview(memoryRow('mixed').state, 3, new Date('2026-09-01T12:00:00Z'), { version: 1, desiredRetention: 0.9 });
  state = submitFsrsReview(state, 2, new Date('2026-09-02T12:00:00Z'), { version: 5, desiredRetention: 0.93 });
  const scheduling = { version: 6 as const, desiredRetention: 0.95 };
  state = submitFsrsReview(state, 3, new Date('2026-09-03T12:00:00Z'), scheduling);
  state.fsrsCard.confirmationDue = '2026-09-04T12:00:00.000Z';
  const evidence = { kind: 'answer_rehearsal' as const, answerExposedAt: '2026-09-03T12:00:00.000Z' };
  state = submitFsrsReview(state, 3, new Date('2026-09-03T12:00:30Z'), scheduling, evidence);
  // Persistence fixtures retain the supplied checkpoint independently of scheduler behavior.
  state.fsrsCard.confirmationDue = '2026-09-04T12:00:00.000Z';
  assert.deepEqual(state.fsrsReviews.map(review => review.scheduling?.version), [1, 5, 6, 6]);
  assert.equal(state.fsrsCard.confirmationDue, '2026-09-04T12:00:00.000Z');
  assert.equal(state.fsrsReviews.at(-1)?.modelApplied, false);
  assert.deepEqual(state.fsrsReviews.at(-1)?.evidence, evidence);
  assert.equal(state.fsrsReviews.at(-1)?.beforeCard?.confirmationDue, state.fsrsCard.confirmationDue);
  const readingTask = { type: 'context_choice' as const, contextVisible: true as const,
    answerExposed: false, mapping: 'hard_on_correct' as const };
  const practiceTask = { ...readingTask, answerExposed: true, mapping: 'practice_only' as const };
  Object.assign(state.fsrsReviews.at(-1)!, { readingTask: practiceTask });
  const verification = { version: 1, userId: 'u', attempts: [
    { attemptId: 'v6-recall', wordId: 'mixed', scheduling, readingTask },
    { attemptId: 'v6-practice', wordId: 'mixed', scheduling, readingTask: practiceTask },
    { attemptId: 'legacy-recall', wordId: 'mixed' },
  ] };
  const extension = { version: 1, userId: 'u', wordId: 'mixed', baselineState: state,
    baselineDaily: [], baselineRaw: [], events: [] };
  const localStorage = {
    'english-ai:v2:memory:state:u:mixed': JSON.stringify(state),
    'english-ai:v2:memory:meta:reading-verification:u': JSON.stringify(verification),
    'english-ai:v2:memory:meta:extension-journal:["u","mixed"]': JSON.stringify(extension),
  };
  const source = new FakeIndexedDb();
  source.stores.memoryState = [{ key: 'u|mixed', state }];
  source.stores.meta = [{ key: 'reading-verification:u', value: verification },
    { key: 'extension-journal:["u","mixed"]', value: extension }];
  const storage = installBrowser(undefined, source);
  applyAppLocalStorage(localStorage);
  const backup = await exportLocalDataBackup({ memoryStorage: 'indexedDB' });
  const target = new FakeIndexedDb(); installBrowser(storage, target);
  await importLocalDataBackup(backup);
  assert.deepEqual(target.stores, source.stores);
  assert.deepEqual(collectAppLocalStorage(), localStorage);
  assert.deepEqual(validateLocalDataBackup({ ...backup, memoryStorage: 'localStorage', indexedDb: null }).localStorage, localStorage);
});

test('v6 backup validation rejects malformed confirmation checkpoints and recall audit fields before replacement', () => {
  const state = submitFsrsReview(memoryRow('audit').state, 3, new Date('2026-09-03T12:00:00Z'),
    { version: 6, desiredRetention: 0.93 });
  const readingTask = { type: 'context_choice', contextVisible: true, answerExposed: false, mapping: 'hard_on_correct' };
  const invalidReadingTasks = [null, [], {}, { ...readingTask, type: 'free_recall' },
    { ...readingTask, contextVisible: false }, { ...readingTask, answerExposed: 'false' },
    { ...readingTask, mapping: 'good_on_correct' },
    ...Object.keys(readingTask).map(missing => Object.fromEntries(Object.entries(readingTask).filter(([key]) => key !== missing)))];
  const malformed: Array<(value: typeof state) => void> = [
    ...['invalid', '2026-02-30T12:00:00Z', null, 1].map(confirmationDue => (value: typeof state) => {
      Object.assign(value.fsrsCard, { confirmationDue });
    }),
    value => { Object.assign(value.fsrsReviews[0].beforeCard!, { confirmationDue: '2026-02-30T12:00:00Z' }); },
    ...[null, {}, { kind: 'unknown' }, { kind: 'answer_rehearsal', answerExposedAt: 'invalid' },
      { kind: 'independent_recall', interveningWord: '' }].map(evidence => (value: typeof state) => {
      Object.assign(value.fsrsReviews[0], { evidence });
    }),
    ...[true, null, 'false'].map(modelApplied => (value: typeof state) => { Object.assign(value.fsrsReviews[0], { modelApplied }); }),
    ...invalidReadingTasks.map(readingTask => (value: typeof state) => { Object.assign(value.fsrsReviews[0], { readingTask }); }),
  ];
  for (const corrupt of malformed) {
    const candidate = structuredClone(state); corrupt(candidate);
    const localStorage = { 'english-ai:v2:memory:state:u:audit': JSON.stringify(candidate) };
    const backup = { format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION, memoryStorage: 'indexedDB', localStorage: {},
      indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores: {
        ...Object.fromEntries(storeNames.map(name => [name, [] as unknown[]])), memoryState: [{ key: 'u|audit', state: candidate }],
      } } };
    assert.throws(() => validateLocalDataBackup(backup), /记录无效/);
    assert.throws(() => validateLocalDataBackup({ ...backup, indexedDb: null, memoryStorage: 'localStorage', localStorage }), /记录无效/);
  }
  for (const readingTask of invalidReadingTasks) {
    const value = { version: 1, userId: 'u', attempts: [{ attemptId: 'invalid-task', readingTask }] };
    const backup = { format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION, memoryStorage: 'indexedDB', localStorage: {},
      indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores: {
        ...Object.fromEntries(storeNames.map(name => [name, [] as unknown[]])), meta: [{ key: 'reading-verification:u', value }],
      } } };
    assert.throws(() => validateLocalDataBackup(backup), /记录无效/);
    assert.throws(() => validateLocalDataBackup({ ...backup, indexedDb: null, memoryStorage: 'localStorage',
      localStorage: { 'english-ai:v2:memory:meta:reading-verification:u': JSON.stringify(value) } }), /记录无效/);
  }
});

test('V2 practice-only New cards keep zero formal memory and positive attempt counts through browser backup', async () => {
  const state = memoryRow('practice-only').state;
  state.fsrsCard.reps = 1;
  const review = { rating: 3, state: 0, due: state.fsrsCard.due, stability: 0, difficulty: 0, elapsedDays: 0,
    lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, review: '2026-09-03T12:00:00.000Z',
    scheduling: { version: 6, desiredRetention: 0.93 }, modelApplied: false,
    evidence: { kind: 'answer_rehearsal', answerExposedAt: '2026-09-03T12:00:00.000Z' },
    readingTask: { type: 'context_choice', contextVisible: true, answerExposed: true, mapping: 'practice_only' },
    beforeCard: { ...state.fsrsCard, reps: 0 } };
  Object.assign(state, { fsrsReviews: [review] });
  const source = new FakeIndexedDb(); source.stores.memoryState = [{ key: 'u|practice-only', state }];
  const storage = installBrowser(undefined, source);
  const localStorage = { 'english-ai:v2:memory:state:u:practice-only': JSON.stringify(state) };
  applyAppLocalStorage(localStorage);
  const backup = await exportLocalDataBackup({ memoryStorage: 'indexedDB' });
  const target = new FakeIndexedDb(); installBrowser(storage, target);
  await importLocalDataBackup(backup);
  assert.deepEqual(target.stores.memoryState, source.stores.memoryState);
  assert.equal(state.lastReview, null); assert.equal(state.fsrsCard.lastReview, undefined);
  assert.equal(state.fsrsCard.state, 0); assert.equal(state.stability, 0); assert.equal(state.fsrsCard.reps, 1);
  assert.deepEqual(validateLocalDataBackup({ ...backup, indexedDb: null, memoryStorage: 'localStorage' }).localStorage, localStorage);
});

test('lookup-only clicks and bounded explicit recall failures are retained and invalid evidence is rejected', () => {
  const event = { userId: 'u', wordId: 'run', articleId: 'a', occurrenceId: 'a:1', localDate: '2026-09-02',
    occurredAt: '2026-09-02T12:00:00Z', eventType: 'click', lookupOnly: true };
  const evidence = { userId: 'u', wordId: 'run', articleId: 'a', localDate: '2026-09-02',
    firstSeenAt: event.occurredAt, lastSeenAt: event.occurredAt, lastRecallFailureAt: event.occurredAt,
    clickedOccurrenceCount: 2, recallFailureCount: 1 };
  const stores = Object.fromEntries(storeNames.map(name => [name, [] as unknown[]]));
  stores.rawEvents = [{ key: 'u|run|2026-09-02', events: [event] }];
  stores.articleEvidence = [{ key: 'u|run|a|2026-09-02', evidence }];
  stores.dailyEvidence = [{ key: 'u|run|2026-09-02', evidence: { ...evidence, articleEvidence: [evidence] } }];
  const backup = { format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION, localStorage: {},
    indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores } };
  assert.deepEqual(validateLocalDataBackup(backup).indexedDb?.stores, stores);
  for (const lookupOnly of [false, null, 'true', 1]) {
    const candidate = structuredClone(backup);
    candidate.indexedDb.stores.rawEvents = [{ key: 'u|run|2026-09-02', events: [{ ...event, lookupOnly }] }];
    assert.throws(() => validateLocalDataBackup(candidate), /记录无效/);
  }
  for (const table of ['articleEvidence', 'dailyEvidence']) for (const recallFailureCount of [-1, 0.5, 3, null, '1']) {
    const candidate = structuredClone(backup);
    candidate.indexedDb.stores[table] = [{ key: table === 'articleEvidence' ? 'u|run|a|2026-09-02' : 'u|run|2026-09-02',
      evidence: { ...evidence, recallFailureCount, articleEvidence: [evidence] } }];
    assert.throws(() => validateLocalDataBackup(candidate), /记录无效/);
  }
  for (const lastRecallFailureAt of ['invalid', '2026-02-30T12:00:00Z', null, 1]) {
    const candidate = structuredClone(backup);
    candidate.indexedDb.stores.articleEvidence = [{ key: 'u|run|a|2026-09-02', evidence: { ...evidence, lastRecallFailureAt } }];
    assert.throws(() => validateLocalDataBackup(candidate), /记录无效/);
  }
});

test('legacy localStorage backups validate added scheduling and evidence fields without requiring modern record shapes', () => {
  const prefix = 'english-ai:v2:memory:';
  const localStorage = {
    [`${prefix}state:u:run`]: JSON.stringify({ wordId: 'run' }),
    [`${prefix}raw:u:run:2026-09-02`]: JSON.stringify([{ eventType: 'click', lookupOnly: true }]),
    [`${prefix}article:u:run:a:2026-09-02`]: JSON.stringify({ clickedOccurrenceCount: 2, recallFailureCount: 0 }),
  };
  const backup = { format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION, memoryStorage: 'localStorage', localStorage, indexedDb: null };
  assert.deepEqual(validateLocalDataBackup(backup).localStorage, localStorage);
  const malformed = [
    [`${prefix}state:u:run`, { fsrsReviews: [{ scheduling: { version: 1, desiredRetention: 0.905 } }] }],
    [`${prefix}state:u:run`, { passiveReadingReviews: [{ beforeCard: {} }] }],
    [`${prefix}raw:u:run:2026-09-02`, [{ eventType: 'click', lookupOnly: false }]],
    [`${prefix}article:u:run:a:2026-09-02`, { clickedOccurrenceCount: 1, recallFailureCount: 2 }],
    [`${prefix}daily:u:run:2026-09-02`, { articleEvidence: [{ clickedOccurrenceCount: 1, recallFailureCount: -1 }] }],
    [`${prefix}article:u:run:a:2026-09-02`, { lastRecallFailureAt: 'invalid' }],
  ] as const;
  for (const [key, value] of malformed) assert.throws(() => validateLocalDataBackup({ ...backup, localStorage: { ...localStorage, [key]: JSON.stringify(value) } }), /记录无效/);
});

test('known recall journals preserve valid new metadata across backup and reject corrupt policies without restricting generic metadata', async () => {
  const scheduling = { version: 1, desiredRetention: 0.95 };
  const conservativeScheduling = { version: 2, desiredRetention: 0.95 };
  const intradayScheduling = { version: 3, desiredRetention: 0.95 };
  const roundScheduling = { version: 4, desiredRetention: 0.95 };
  const beforeCard = memoryRow().state.fsrsCard;
  const intradayBeforeCard = { ...beforeCard, state: 1, learningSteps: 2, reps: 2,
    due: '2026-09-02T12:10:00.000Z', lastReview: '2026-09-02T12:00:00.000Z' };
  const roundBeforeCard = { ...intradayBeforeCard, due: intradayBeforeCard.lastReview };
  const verification = { version: 1, userId: 'u', attempts: [{ attemptId: 'recall-v1', scheduling },
    { attemptId: 'recall-v2', scheduling: conservativeScheduling },
    { attemptId: 'recall-v3', scheduling: intradayScheduling },
    { attemptId: 'recall-v4', scheduling: roundScheduling }, { attemptId: 'legacy' }] };
  const extension = { version: 1, userId: 'u', wordId: 'run',
    pendingFailureDates: ['2026-09-02'],
    baselineState: { fsrsReviews: [{ scheduling, beforeCard }, { scheduling: conservativeScheduling, beforeCard },
      { scheduling: intradayScheduling, beforeCard: intradayBeforeCard },
      { scheduling: roundScheduling, beforeCard: roundBeforeCard }] },
    baselineDaily: [{ clickedOccurrenceCount: 1, recallFailureCount: 1,
      articleEvidence: [{ clickedOccurrenceCount: 1, recallFailureCount: 1, lastRecallFailureAt: '2026-09-02T12:00:00Z' }] }],
    baselineRaw: [{ eventType: 'click', lookupOnly: true }], events: [{ eventType: 'click', lookupOnly: true }] };
  const source = new FakeIndexedDb();
  source.stores.meta = [
    { key: 'reading-verification:u', value: verification }, { key: 'extension-journal:["u","run"]', value: extension },
    { key: 'generic', value: { attempts: [{ scheduling: 'extensible custom value' }] } }, { key: 'nullable', value: null },
  ];
  const storage = installBrowser(undefined, source);
  const backup = await exportLocalDataBackup({ memoryStorage: 'indexedDB' });
  const target = new FakeIndexedDb(); installBrowser(storage, target);
  await importLocalDataBackup(backup);
  assert.deepEqual(target.stores, source.stores);
  const invalidJournals: Array<[string, unknown]> = [
    ['reading-verification:u', { ...verification, attempts: [{ scheduling: { version: 1, desiredRetention: 0.905 } }] }],
    ['reading-verification:u', { ...verification, attempts: [{ scheduling: null }] }],
    ['extension-journal:["u","run"]', { ...extension, baselineState: { fsrsReviews: [{ beforeCard: {} }] } }],
    ['extension-journal:["u","run"]', { ...extension, baselineState: { fsrsReviews: [{ scheduling: { version: 7, desiredRetention: 0.95 } }] } }],
    ['reading-verification:u', { ...verification, attempts: [{ scheduling: { version: 7, desiredRetention: 0.95 } }] }],
    ...[null, '2026-09-02', ['2026-02-30'], [1]].map(pendingFailureDates =>
      ['extension-journal:["u","run"]', { ...extension, pendingFailureDates }] as [string, unknown]),
    ['extension-journal:["u","run"]', { ...extension, baselineDaily: [{ articleEvidence: [{ clickedOccurrenceCount: 1, recallFailureCount: 2 }] }] }],
    ['extension-journal:["u","run"]', { ...extension, baselineDaily: [{ articleEvidence: [{ lastRecallFailureAt: 'invalid' }] }] }],
    ['extension-journal:["u","run"]', { ...extension, baselineRaw: [{ eventType: 'click', lookupOnly: false }] }],
    ['extension-journal:["u","run"]', { ...extension, events: [{ eventType: 'click', lookupOnly: false }] }],
  ];
  for (const [key, value] of invalidJournals) {
    const candidate = structuredClone(backup);
    candidate.indexedDb!.stores.meta = [{ key, value }];
    assert.throws(() => validateLocalDataBackup(candidate), /记录无效/);
    assert.throws(() => validateLocalDataBackup({ ...candidate, memoryStorage: 'localStorage', indexedDb: null,
      localStorage: { [`english-ai:v2:memory:meta:${key}`]: JSON.stringify(value) } }), /记录无效/);
  }
  const legacy = { version: 1, attempts: [{}] };
  assert.doesNotThrow(() => validateLocalDataBackup({ ...backup, indexedDb: null, memoryStorage: 'localStorage',
    localStorage: { 'english-ai:v2:memory:meta:reading-verification:u': JSON.stringify(legacy) } }));
});
