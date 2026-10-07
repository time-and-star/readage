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

const globalDescriptors = new Map(['window', 'navigator', 'indexedDB'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
afterEach(() => {
  for (const [key, descriptor] of globalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const storeNames = ['rawEvents', 'articleEvidence', 'dailyEvidence', 'memoryState', 'finalizationTasks', 'meta'];
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
  source.stores.memoryState = [{ key: 'known', value: { wordId: 'run' } }];
  source.stores.meta = [{ key: 'preferences', value: { dailyNewWordLimit: 0 } }];
  const storage = installBrowser(undefined, source);
  storage.setItem('english-ai:v2:articles', 'source');
  const backup = await exportLocalDataBackup({ memoryStorage: 'indexedDB' });
  assert.equal(backup.memoryStorage, 'indexedDB');
  const target = new FakeIndexedDb();
  target.stores.memoryState = [{ key: 'unrelated', value: { wordId: 'other' } }];
  installBrowser(storage, target);
  storage.setItem('english-ai:v2:articles', 'target');
  await importLocalDataBackup(backup);
  assert.deepEqual(target.stores, source.stores);
  assert.equal(storage.getItem('english-ai:v2:articles'), 'source');
});

test('a legacy backup without memory cannot overwrite an existing target memory library', async () => {
  const factory = new FakeIndexedDb();
  factory.stores.memoryState = [{ key: 'known', value: { wordId: 'run' } }];
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
  factory.stores.memoryState = [{ key: 'target', value: { wordId: 'other' } }];
  const storage = installBrowser(undefined, factory);
  await importLocalDataBackup({ format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
    memoryStorage: 'localStorage', localStorage: { 'english-ai:v2:memory:state:user:run': '{"wordId":"run"}' }, indexedDb: null });
  assert.ok(Object.values(factory.stores).every(rows => rows.length === 0));
  assert.ok(storage.getItem('english-ai:v2:memory:state:user:run'));
});

test('restoration write failures roll back both memory and browser history', async () => {
  const factory = new FakeIndexedDb();
  factory.stores.memoryState = [{ key: 'target', value: { wordId: 'other' } }];
  const before = structuredClone(factory.stores);
  const storage = installBrowser(undefined, factory);
  storage.setItem('english-ai:v2:articles', 'target');
  const stores = Object.fromEntries(storeNames.map(name => [name, [] as unknown[]]));
  stores.memoryState = [{ key: 'source', value: { wordId: 'run' } }];
  factory.failNextWrite = true;
  await assert.rejects(importLocalDataBackup({ format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
    memoryStorage: 'indexedDB', localStorage: { 'english-ai:v2:articles': 'source' },
    indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores } }), /quota/);
  assert.deepEqual(factory.stores, before);
  assert.equal(storage.getItem('english-ai:v2:articles'), 'target');
});

test('a history write failure after memory replacement restores both original libraries', async () => {
  const factory = new FakeIndexedDb();
  factory.stores.memoryState = [{ key: 'target', value: { wordId: 'other' } }];
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
