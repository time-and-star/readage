import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createPreferredMemoryStorage, IndexedDbMemoryStorage, MemoryStorageMigrationError } from '../src/lib/memoryV2/indexedDbImpl';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';

class LocalStorageFake implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

/** Exercise the real IndexedDbMemoryStorage methods, not an injected MemoryStorage. */
class IndexedDbFake {
  rows = new Map<string, Map<string, any>>(['rawEvents', 'articleEvidence', 'dailyEvidence', 'memoryState', 'finalizationTasks', 'meta']
    .map(name => [name, new Map()]));
  failOpen = false;
  failRead = false;
  failReceipt = false;
  open() {
    const request: any = {};
    queueMicrotask(() => {
      if (this.failOpen) { request.error = new Error('IndexedDB unavailable'); request.onerror?.(); return; }
      request.result = { transaction: (name: string, mode: string) => this.transaction(name, mode) };
      request.onsuccess?.();
    });
    return request;
  }
  private transaction(name: string, mode: string) {
    const staged = new Map([...this.rows.get(name)!].map(([key, value]) => [key, structuredClone(value)]));
    const tx: any = { objectStore: () => ({
      get: (key: string) => this.request(tx, () => staged.get(key)),
      getAll: () => this.request(tx, () => [...staged.values()]),
      put: (row: any) => {
        if (this.failReceipt && row.key === 'localStorageMigrationReceiptV2') throw new Error('Receipt write failed');
        staged.set(row.key, structuredClone(row));
      },
      delete: (key: string) => staged.delete(key),
      openCursor: () => {
        const request: any = {};
        const rows = [...staged];
        let index = 0;
        const next = () => queueMicrotask(() => {
          const entry = rows[index++];
          request.result = entry ? { key: entry[0], value: structuredClone(entry[1]), continue: next } : null;
          request.onsuccess?.();
        });
        next();
        return request;
      },
    }) };
    setImmediate(() => {
      if (tx.error) return;
      if (mode === 'readwrite') this.rows.set(name, staged);
      tx.oncomplete?.();
    });
    return tx;
  }
  private request(tx: any, value: () => unknown) {
    const request: any = {};
    queueMicrotask(() => {
      if (this.failRead) { request.error = tx.error = new Error('IndexedDB read failed'); request.onerror?.(); tx.onerror?.(); }
      else { request.result = structuredClone(value()); request.onsuccess?.(); }
    });
    return request;
  }
}

const originals = new Map(['localStorage', 'indexedDB', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function browser(factory?: IndexedDbFake) {
  const source = new LocalStorageFake();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: source });
  Reflect.deleteProperty(globalThis, 'window');
  if (factory) Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  else Reflect.deleteProperty(globalThis, 'indexedDB');
  return source;
}

test('a missing or unavailable IndexedDB API still selects the normal localStorage fallback', async () => {
  browser();
  assert.ok(await createPreferredMemoryStorage() instanceof LocalStorageMemoryStorage);
  const factory = new IndexedDbFake();
  factory.failOpen = true;
  browser(factory);
  assert.ok(await createPreferredMemoryStorage() instanceof LocalStorageMemoryStorage);
});

test('an opened database with an unreadable recovery record rejects instead of presenting an empty fallback library', async () => {
  const factory = new IndexedDbFake();
  factory.failRead = true;
  browser(factory);
  await assert.rejects(createPreferredMemoryStorage(), MemoryStorageMigrationError);
});

test('a source format error degrades real startup, preserves the main library and source, and recovers after retry', async () => {
  const factory = new IndexedDbFake();
  const source = browser(factory);
  const existing = initializeWordMemory('u1', 'main');
  factory.rows.get('memoryState')!.set('u1|main', { key: 'u1|main', state: existing });
  const sourceKey = 'english-ai:v2:memory:state:u1:fallback';
  source.setItem(sourceKey, '{invalid json');
  const store = new MemoryV2Store({ userId: 'u1', timezone: 'UTC' });
  try {
    await assert.rejects(store.start(), MemoryStorageMigrationError);
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.ready, false);
    assert.equal(snapshot.status, 'degraded');
    assert.equal(snapshot.retryable, true);
    assert.match(snapshot.lifecycleError!, /已有记录和恢复源均已保留/);
    assert.deepEqual(factory.rows.get('memoryState')!.get('u1|main').state, existing);
    assert.equal(source.getItem(sourceKey), '{invalid json');
    source.setItem(sourceKey, JSON.stringify(initializeWordMemory('u1', 'fallback')));
    await store.start();
    assert.equal(store.getSnapshot().ready, true);
    assert.equal(store.getSnapshot().status, 'ready');
    assert.equal(store.getSnapshot().lifecycleError, null);
    assert.equal(store.system.getMemoryStorageKind(), 'indexedDB');
    assert.ok(factory.rows.get('memoryState')!.has('u1|main'));
    assert.ok(factory.rows.get('memoryState')!.has('u1|fallback'));
    assert.equal(source.getItem(sourceKey), null);
  } finally { store.dispose(); }
});

test('a receipt write failure degrades startup and a retry verifies recovery before releasing local source bytes', async () => {
  const factory = new IndexedDbFake();
  factory.failReceipt = true;
  const source = browser(factory);
  const sourceKey = 'english-ai:v2:memory:state:u1:run';
  const memory = initializeWordMemory('u1', 'run');
  source.setItem(sourceKey, JSON.stringify(memory));
  const store = new MemoryV2Store({ userId: 'u1', timezone: 'UTC' });
  try {
    await assert.rejects(store.start(), MemoryStorageMigrationError);
    assert.equal(store.getSnapshot().status, 'degraded');
    assert.equal(source.getItem(sourceKey), JSON.stringify(memory));
    factory.failReceipt = false;
    await store.start();
    assert.equal(store.getSnapshot().status, 'ready');
    assert.equal(source.getItem(sourceKey), null);
    assert.equal(factory.rows.get('memoryState')!.size, 1);
  } finally { store.dispose(); }
});

test('successful real initialization migrates metadata and selects IndexedDB', async () => {
  const factory = new IndexedDbFake();
  const source = browser(factory);
  source.setItem('english-ai:v2:memory:meta:reading-verification:u1', JSON.stringify({ version: 1, userId: 'u1', attempts: [] }));
  const storage = await createPreferredMemoryStorage();
  assert.ok(storage instanceof IndexedDbMemoryStorage);
  assert.equal(source.length, 0);
  assert.deepEqual(await storage.getMeta?.('reading-verification:u1'), { version: 1, userId: 'u1', attempts: [] });
});
