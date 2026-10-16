import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { LOCAL_PROFILE_KEY } from '../src/lib/localDatabaseProtocol';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';

class BrowserStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
}

test('desktop client migrates legacy memory, rebases conflicts, retries ambiguous commits and blocks incomplete backup', { timeout: 30_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-sqlite-client-'));
  const filename = path.join(directory, 'learning.sqlite');
  const nativeFetch = globalThis.fetch;
  const saved = new Map(['window', 'document', 'localStorage', 'navigator', 'indexedDB', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const browser = new BrowserStorage(), events = new EventTarget();
  let poll: (() => void) | undefined, loseResponses = 0, concurrentChange: (() => void) | undefined, rejectCommits = false;
  const originalState = submitFsrsReview(initializeWordMemory('u', 'serendipity'), 'Good', new Date('2026-09-01T12:00:00Z'));
  browser.setItem('english-ai:v2:articles', '[{"id":"article","title":"original","content":"entire original article"}]');
  browser.setItem('english-ai:v2:memory:state:u:serendipity', JSON.stringify(originalState));
  browser.setItem('unrelated-app', 'untouched');
  const originalBytes = new Map(browser.values);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: browser, addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    setInterval: (callback: () => void) => { poll = callback; return 1; },
    location: { reload() {} },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: browser });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, work: () => unknown) => work() } } });
  Reflect.deleteProperty(globalThis, 'indexedDB');
  // Server backup validation also imports storage; install the browser first so its listeners exist.
  const { createLocalDataRouter } = await import('../server/localDatabase/routes');
  const { LocalLearningDatabase } = await import('../server/localDatabase/store');
  const api = createLocalDataRouter({ host: '127.0.0.1', filename, env: { NODE_ENV: 'development' } });
  const app = express(); app.use('/api/local-data', api.router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  let other: import('../server/localDatabase/store').LocalLearningDatabase | undefined;
  let memoryStore: import('../src/lib/memoryV2/memoryStore').MemoryV2Store | undefined;
  const requests: { endpoint: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ endpoint: url.split('/').pop()!, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/commit')) {
      if (rejectCommits) return new Response(JSON.stringify({ error: 'disk unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      if (concurrentChange) { const change = concurrentChange; concurrentChange = undefined; change(); }
    }
    const response = await nativeFetch(url.startsWith('/') ? origin + url : input, init);
    if (url.endsWith('/commit') && loseResponses > 0) { loseResponses--; throw new TypeError('response lost after server commit'); }
    return response;
  };
  try {
    const database = await import('../src/lib/localDatabase');
    const storage = await import('../src/lib/storage');
    const backups = await import('../src/lib/localDataBackup');
    const { withMemoryWriteLock } = await import('../src/lib/browserExtension/memoryLock');
    const { createPreferredMemoryStorage } = await import('../src/lib/memoryV2/indexedDbImpl');
    const { SqliteMemoryStorage } = await import('../src/lib/memoryV2/sqliteImpl');
    await database.initializeLocalDatabase();
    const profile = database.getLocalDatabaseSnapshot()!.profile;
    assert.equal(database.isLocalDatabaseActive(), true);
    assert.equal(browser.getItem(LOCAL_PROFILE_KEY), profile.id);
    for (const [key, value] of originalBytes) assert.equal(browser.getItem(key), value);
    assert.equal(database.getApplicationStorage()!.getItem('english-ai:v2:articles'), originalBytes.get('english-ai:v2:articles'));
    const memory = await withMemoryWriteLock(() => createPreferredMemoryStorage());
    assert.ok(memory instanceof SqliteMemoryStorage);
    assert.deepEqual(await memory.getMemoryState('u', 'serendipity'), originalState);
    other = new LocalLearningDatabase(filename);

    const historyKey = 'english-ai:v2:articles';
    const historyBefore = JSON.parse(database.getApplicationStorage()!.getItem(historyKey)!);
    const requestStart = requests.length;
    const opened = await storage.commitPersistentUpdate<any[]>(database.getApplicationStorage()!, historyKey, [],
      articles => articles.map(item => ({ ...item, lastOpenedAt: '2026-10-09T02:00:00Z' })));
    const openingRequests = requests.slice(requestStart);
    assert.equal(openingRequests.some(item => item.endpoint === 'query' && item.body.table === 'settings'), false,
      'hydrated settings need no duplicate read at the same revision');
    const openingCommit = openingRequests.find(item => item.endpoint === 'commit')!.body;
    assert.deepEqual(openingCommit.changes, [{ table: 'settings', key: historyKey,
      articleMetadata: [{ id: 'article', values: { lastOpenedAt: '2026-10-09T02:00:00Z' }, deletedFields: [] }] }]);
    assert.equal(JSON.stringify(openingCommit).includes('entire original article'), false);
    assert.deepEqual(JSON.parse(other.settings(profile.id)[historyKey]), opened);
    assert.equal(opened[0].content, historyBefore[0].content);
    assert.deepEqual(JSON.parse(database.getApplicationStorage()!.getItem(historyKey)!), opened);

    const unchangedRevision = other.profile(profile.id).revision;
    await storage.commitPersistentUpdate<any[]>(database.getApplicationStorage()!, historyKey, [], articles => articles);
    assert.equal(other.profile(profile.id).revision, unchangedRevision, 'unchanged settings do not advance the database revision');
    const bodyRequestStart = requests.length;
    const edited = await storage.commitPersistentUpdate<any[]>(database.getApplicationStorage()!, historyKey, [],
      articles => articles.map(item => ({ ...item, content: 'edited original article' })));
    const fullCommit = requests.slice(bodyRequestStart).find(item => item.endpoint === 'commit')!.body;
    assert.equal(fullCommit.changes[0].articleMetadata, undefined);
    assert.deepEqual(JSON.parse(fullCommit.changes[0].value), edited);
    assert.deepEqual(JSON.parse(other.settings(profile.id)[historyKey]), edited);

    // A second browser commits between our read and write: retry must re-read its value.
    const key = 'english-ai:v2:concurrent-list';
    concurrentChange = () => { other!.commit(profile.id, other!.profile(profile.id).revision, [{ table: 'settings', key, value: '["other-browser"]' }]); };
    const merged = await storage.commitPersistentUpdate<string[]>(database.getApplicationStorage()!, key, [], prior => [...prior, 'this-browser']);
    assert.deepEqual(merged, ['other-browser', 'this-browser']);
    assert.equal(other.settings(profile.id)[key], '["other-browser","this-browser"]');

    const countKey = 'english-ai:v2:retry-count';
    let computations = 0;
    loseResponses = 1;
    await storage.commitPersistentUpdate<number>(database.getApplicationStorage()!, countKey, 0, count => { computations++; return count + 1; });
    assert.equal(other.settings(profile.id)[countKey], '1'); assert.equal(computations, 1);
    // All transport acknowledgements fail; a later retry with the same identity only confirms.
    const operation = randomUUID(); loseResponses = 3;
    await assert.rejects(storage.commitPersistentUpdate<number>(database.getApplicationStorage()!, countKey, 0, count => { computations++; return count + 1; }, undefined, operation), /response lost/);
    assert.equal(other.settings(profile.id)[countKey], '2');
    assert.equal(await storage.commitPersistentUpdate<number>(database.getApplicationStorage()!, countKey, 0, count => { computations++; return count + 1; }, undefined, operation), 2);
    assert.equal(computations, 2);

    const event = { userId: 'u', wordId: 'serendipity', articleId: 'article', occurrenceId: 'p2', eventType: 'click' as const, occurredAt: '2026-10-09T01:00:00Z', localDate: '2026-10-09' };
    await withMemoryWriteLock(() => memory.saveRawEvent(event));
    await withMemoryWriteLock(() => memory.saveRawEvent(event));
    assert.equal((await memory.getRawEventsByDate('u', 'serendipity', event.localDate)).length, 1);
    const snapshot = await backups.exportLocalDataBackup({ memoryStorage: 'sqlite' });
    assert.deepEqual((snapshot.indexedDb!.stores.memoryState[0] as any).state, originalState);
    assert.equal(snapshot.localStorage[countKey], '2');
    assert.equal(browser.getItem(countKey), null);

    let releaseWriter!: () => void, writerStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const started = new Promise<void>(resolve => { writerStarted = resolve; });
    const slowWriter = withMemoryWriteLock(async () => { await memory.setMeta!('snapshot-pending', { saved: true }); writerStarted(); await gate; });
    await started;
    let exported = false;
    const queuedBackup = backups.exportLocalDataBackup({ memoryStorage: 'sqlite' }).then(value => { exported = true; return value; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(exported, false);
    releaseWriter(); await slowWriter;
    assert.deepEqual((await queuedBackup).indexedDb!.stores.meta.find((row: any) => row.key === 'snapshot-pending'), { key: 'snapshot-pending', value: { saved: true } });

    // Own commits may follow unseen updates; the next poll must still refresh those settings.
    const externalKey = 'english-ai:v2:external-test';
    other.commit(profile.id, other.profile(profile.id).revision, [{ table: 'settings', key: externalKey, value: '"from other browser"' }]);
    await storage.commitPersistentUpdate<number>(database.getApplicationStorage()!, countKey, 0, count => count + 1);
    const changed = new Promise<string[]>(resolve => events.addEventListener('readage-local-data-changed', event => resolve((event as CustomEvent).detail.keys), { once: true }));
    poll!(); assert.deepEqual(new Set(await changed), new Set([key, externalKey, countKey]));
    assert.equal(database.getApplicationStorage()!.getItem(externalKey), '"from other browser"');
    assert.equal(storage.readPersistentValue(externalKey, ''), 'from other browser');
    await database.withLocalDatabaseAccess(async () => {});

    const stableHistory = storage.readPersistentValue(historyKey, []);
    other.commit(profile.id, other.profile(profile.id).revision, [{ table: 'meta', key: 'external-memory-only', value: true }]);
    const memoryChanged = new Promise<string[]>(resolve => events.addEventListener('readage-local-data-changed', event => resolve((event as CustomEvent).detail.keys), { once: true }));
    poll!(); assert.deepEqual(await memoryChanged, []);
    assert.equal(storage.readPersistentValue(historyKey, []), stableHistory, 'memory-only polls retain article object identity');
    await database.withLocalDatabaseAccess(async () => {});
    other.commit(profile.id, other.profile(profile.id).revision, [{ table: 'settings', key: externalKey, value: null, deleted: true }]);
    const deleted = new Promise<void>(resolve => events.addEventListener('readage-local-data-changed', () => resolve(), { once: true }));
    poll!(); await deleted;
    assert.equal(database.getApplicationStorage()!.getItem(externalKey), null);
    assert.equal(storage.readPersistentValue(externalKey, ''), '');

    rejectCommits = true;
    database.getApplicationStorage()!.setItem('english-ai:v2:pending-test', 'true');
    await assert.rejects(backups.exportLocalDataBackup({ memoryStorage: 'sqlite' }), /尚未全部保存/);
    assert.match(database.getLocalDatabaseSnapshot()!.error!, /disk unavailable/);
    rejectCommits = false; await database.flushLocalDatabaseWrites();
    assert.equal(other.settings(profile.id)['english-ai:v2:pending-test'], 'true');

    // A failed SQL startup must never activate the constructor's old browser backend.
    const { MemoryV2Store } = await import('../src/lib/memoryV2/memoryStore');
    memoryStore = new MemoryV2Store({ userId: 'u', timezone: 'Asia/Shanghai' });
    rejectCommits = true;
    await assert.rejects(memoryStore.ensureReady(), /disk unavailable/);
    assert.equal(memoryStore.getSnapshot().ready, false);
    assert.equal(memoryStore.getSnapshot().status, 'degraded');
    rejectCommits = false; await memoryStore.ensureReady();
    assert.equal(memoryStore.system.getMemoryStorageKind(), 'sqlite');
    assert.equal(memoryStore.getSnapshot().ready, true);
    for (const [key, value] of originalBytes) assert.equal(browser.getItem(key), value);
  } finally {
    memoryStore?.dispose(); other?.close();
    await new Promise<void>(resolve => server.close(() => resolve())); api.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-sqlite-client-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
