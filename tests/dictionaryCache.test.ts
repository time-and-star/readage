import test from 'node:test';
import assert from 'node:assert/strict';
import { DictionaryCatalogCache, dictionaryCacheKey, type CatalogSnapshot } from '../packages/dictionary/cache';
import { DICTIONARY_PROTOCOL_VERSION, type SourceCatalog } from '../packages/dictionary/contracts';

const catalog = (version: string): SourceCatalog => ({ protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: version, defaultSource: null, sources: [] });

test('catalogue checks deduplicate for 60 seconds, detect new versions, and preserve the last known version offline', async () => {
  let now = 100_000; let calls = 0; let version = 'v1'; let offline = false;
  let stored: CatalogSnapshot | undefined;
  const options = { now: () => now, async read() { return stored; }, async write(value: CatalogSnapshot) { stored = value; },
    async fetchCatalog() { calls++; if (offline) throw new Error('offline'); return catalog(version); } };
  const cache = new DictionaryCatalogCache(options);
  const first = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.deepEqual(first.map(value => value?.catalogVersion), ['v1', 'v1', 'v1']); assert.equal(calls, 1);
  now += 59_999; version = 'v2'; assert.equal((await cache.get())?.catalogVersion, 'v1'); assert.equal(calls, 1);
  now++; assert.equal((await cache.get())?.catalogVersion, 'v2'); assert.equal(calls, 2);
  offline = true; now += 60_000;
  assert.equal((await cache.get())?.catalogVersion, 'v2'); assert.equal(calls, 3);
  assert.equal((await new DictionaryCatalogCache(options).get())?.catalogVersion, 'v2', 'offline restart reads persisted catalogue');
  assert.notEqual(dictionaryCacheKey('en', 'v1', 'bank'), dictionaryCacheKey('en', 'v2', 'bank'));
  assert.notEqual(dictionaryCacheKey('en', 'v1', 'bank'), dictionaryCacheKey('ja', 'v1', 'bank'));
  assert.ok(dictionaryCacheKey('ja', 'v1', '𠮷・かな').includes('dictionary-api.v1:ja:'));
});

test('cancelling one catalogue caller leaves the shared check usable by other callers', async () => {
  let release!: (value: SourceCatalog) => void;
  const cache = new DictionaryCatalogCache({ async read() { return undefined; }, async write() {},
    fetchCatalog: () => new Promise(resolve => { release = resolve; }) });
  const controller = new AbortController();
  const cancelled = cache.get(controller.signal); const surviving = cache.get();
  await Promise.resolve(); controller.abort(); release(catalog('v1'));
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await surviving)?.catalogVersion, 'v1');
});

test('a version learned from a lookup remains available after an offline restart without a catalogue response', async () => {
  let stored: CatalogSnapshot | undefined;
  const options = { async read() { return stored; }, async write(value: CatalogSnapshot) { stored = value; },
    async fetchCatalog(): Promise<SourceCatalog> { throw new Error('offline'); } };
  const cache = new DictionaryCatalogCache(options);
  assert.equal(await cache.get(), undefined);
  await cache.observeVersion('lookup-content.v3');
  assert.equal((await cache.get())?.catalogVersion, 'lookup-content.v3');
  assert.equal((await new DictionaryCatalogCache(options).get())?.catalogVersion, 'lookup-content.v3');
});

test('saving settings supersedes an in-flight catalogue check and rejects its stale lookup version', async () => {
  let finish!: (value: SourceCatalog) => void;
  let stored: CatalogSnapshot | undefined;
  const cache = new DictionaryCatalogCache({ async read() { return undefined; },
    async write(value) { stored = value; }, fetchCatalog: () => new Promise(resolve => { finish = resolve; }) });
  const oldCheck = cache.get(); await Promise.resolve();
  await cache.applyCatalog(catalog('saved-settings.v2'));
  assert.equal((await cache.get())?.catalogVersion, 'saved-settings.v2', 'new requests need not await the old check');
  finish(catalog('old-settings.v1'));
  assert.equal((await oldCheck)?.catalogVersion, 'saved-settings.v2');
  await cache.observeVersion('old-settings.v1', 'old-settings.v1');
  assert.equal(stored?.catalog.catalogVersion, 'saved-settings.v2');
});

test('saving settings supersedes a delayed storage load and is available after an offline restart', async () => {
  let finishRead!: (value: CatalogSnapshot) => void;
  let stored: CatalogSnapshot | undefined;
  const cache = new DictionaryCatalogCache({ read: () => new Promise(resolve => { finishRead = resolve; }),
    async write(value) { stored = value; }, async fetchCatalog() { throw new Error('offline'); } });
  const oldLoad = cache.get();
  await cache.applyCatalog(catalog('saved.v2'));
  finishRead({ catalog: catalog('cached.v1'), checkedAt: Date.now() });
  assert.equal((await oldLoad)?.catalogVersion, 'saved.v2');
  const restarted = new DictionaryCatalogCache({ async read() { return stored; }, async write() {},
    async fetchCatalog() { throw new Error('offline'); } });
  assert.equal((await restarted.get())?.catalogVersion, 'saved.v2');
});

test('an asynchronous old cache write cannot overwrite the confirmed saved catalogue', async () => {
  let finishWrite!: () => void;
  let stored: CatalogSnapshot | undefined; let writes = 0;
  const cache = new DictionaryCatalogCache({ async read() { return undefined; }, async fetchCatalog() { return catalog('v1'); },
    async write(value) {
      if (++writes === 1) await new Promise<void>(resolve => { finishWrite = resolve; });
      stored = value;
    } });
  const oldCheck = cache.get();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const saved = cache.applyCatalog(catalog('v2'));
  finishWrite(); await Promise.all([saved, oldCheck]);
  assert.equal(stored?.catalog.catalogVersion, 'v2');
});
