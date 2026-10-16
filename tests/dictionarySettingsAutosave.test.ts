import assert from 'node:assert/strict';
import test from 'node:test';
import { DictionarySettingsAutosave } from '../src/lib/dictionarySettingsAutosave';
import { DictionarySettingsError, moveDictionarySource, setDictionaryEnabled,
  type DictionarySettingsSnapshot, type DictionarySettingsUpdate } from '../src/lib/dictionarySettingsClient';

const initial: DictionarySettingsSnapshot = {
  settings: { version: 'dictionary-settings.v1', revision: 'r1', enabledSources: ['native', 'old', 'extra'],
    sourceOrder: ['native', 'old', 'extra'], defaultSource: 'native' },
  catalog: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'c1', defaultSource: 'native', sources: [] },
};
function saved(update: DictionarySettingsUpdate, revision = 'r2'): DictionarySettingsSnapshot {
  return { settings: { ...initial.settings, ...update, revision }, catalog: { ...initial.catalog, catalogVersion: revision } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

test('automatic saves serialize rapid edits using the confirmed revision and keep the latest ordering and toggles', async () => {
  const first = deferred<DictionarySettingsSnapshot>();
  const requests: DictionarySettingsUpdate[] = [];
  const catalogs: string[] = [];
  const writer = new DictionarySettingsAutosave(initial, {
    save: update => { requests.push(update); return requests.length === 1 ? first.promise : Promise.resolve(saved(update, 'r3')); },
    applyCatalog: async catalog => { catalogs.push(catalog.catalogVersion); },
  });
  const moved = moveDictionarySource(initial.settings, 'extra', -1);
  const writing = writer.update(moved);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  const latest = setDictionaryEnabled(moveDictionarySource(moved, 'extra', -1), 'old', false);
  void writer.update(latest);
  first.resolve(saved(requests[0]));
  await writing;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].expectedRevision, 'r1');
  assert.equal(requests[1].expectedRevision, 'r2');
  assert.deepEqual(requests[1].sourceOrder, ['extra', 'native', 'old']);
  assert.deepEqual(requests[1].enabledSources, ['extra', 'native']);
  assert.equal(writer.getSnapshot().settings.defaultSource, 'native');
  assert.equal(writer.getSnapshot().settings.revision, 'r3');
  assert.equal(writer.getSnapshot().status, 'idle');
  assert.deepEqual(catalogs, ['r2', 'r3']);
});

test('a failed write remains an explicit failure and retry saves the latest choice without inventing a confirmation', async () => {
  const requests: DictionarySettingsUpdate[] = [];
  const writer = new DictionarySettingsAutosave(initial, {
    save: async update => { requests.push(update); if (requests.length === 1) throw new Error('disk unavailable'); return saved(update); },
    applyCatalog: async () => {},
  });
  const next = setDictionaryEnabled(initial.settings, 'old', false);
  await writer.update(next);
  assert.equal(writer.getSnapshot().status, 'error');
  assert.equal(writer.getSnapshot().snapshot, initial);
  assert.deepEqual(writer.getSnapshot().settings.enabledSources, ['native', 'extra']);
  assert.match(writer.getSnapshot().message!, /重试/);
  assert.equal(requests.length, 1, 'failures do not loop endlessly');
  await writer.retry();
  assert.equal(requests[1].expectedRevision, 'r1');
  assert.equal(writer.getSnapshot().status, 'idle');
  assert.equal(writer.getSnapshot().message, undefined);
});

test('revision conflicts require reload rather than automatically overwriting another window', async () => {
  let calls = 0;
  const writer = new DictionarySettingsAutosave(initial, {
    save: async () => { calls++; throw new DictionarySettingsError('conflict', 409); }, applyCatalog: async () => {},
  });
  await writer.update(moveDictionarySource(initial.settings, 'extra', -1));
  assert.equal(writer.getSnapshot().status, 'conflict');
  assert.match(writer.getSnapshot().message!, /重新加载/);
  await writer.retry();
  await writer.update(setDictionaryEnabled(initial.settings, 'old', false));
  assert.equal(calls, 1);
  assert.equal(writer.getSnapshot().snapshot.settings.revision, 'r1');
});

test('leaving the settings view detaches updates while an accepted write and catalog refresh finish', async () => {
  const response = deferred<DictionarySettingsSnapshot>();
  let applied = 0;
  let notifications = 0;
  const writer = new DictionarySettingsAutosave(initial, { save: () => response.promise, applyCatalog: async () => { applied++; } });
  const unsubscribe = writer.subscribe(() => { notifications++; });
  const next = moveDictionarySource(initial.settings, 'extra', -1);
  const pending = writer.update(next);
  await Promise.resolve();
  unsubscribe();
  const beforeLeaving = notifications;
  response.resolve(saved({ expectedRevision: 'r1', ...next }));
  await pending;
  assert.equal(notifications, beforeLeaving);
  assert.equal(applied, 1);
  assert.equal(writer.getSnapshot().snapshot.settings.revision, 'r2');
});

test('cache refresh failure does not turn a durable save into a write failure or cause a duplicate write', async () => {
  let calls = 0;
  const writer = new DictionarySettingsAutosave(initial, {
    save: async update => { calls++; return saved(update); }, applyCatalog: async () => { throw new Error('browser storage'); },
  });
  await writer.update(moveDictionarySource(initial.settings, 'extra', -1));
  assert.equal(writer.getSnapshot().status, 'idle');
  assert.equal(writer.getSnapshot().snapshot.settings.revision, 'r2');
  assert.match(writer.getSnapshot().cacheWarning!, /已保存/);
  await writer.retry();
  assert.equal(calls, 1);
});

test('loading corrupt preferences preserves the original file until an edit or explicit repair is requested', async () => {
  let calls = 0;
  const writer = new DictionarySettingsAutosave({ ...initial, warning: 'unreadable preferences' }, {
    save: async update => { calls++; return saved(update); }, applyCatalog: async () => {},
  });
  assert.equal(calls, 0);
  await writer.retry();
  assert.equal(calls, 1);
  assert.equal(writer.getSnapshot().snapshot.warning, undefined);
  assert.equal(writer.getSnapshot().status, 'idle');
});
