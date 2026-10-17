import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalLearningDatabase, LocalDatabaseConflict } from '../server/localDatabase/store';
import { MEMORY_TABLES } from '../src/lib/localDatabaseProtocol';

test('shared client merges through the native transport and rejects concurrent updates without changing recovery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-merge-client-'));
  const db = new LocalLearningDatabase(path.join(root, 'test.sqlite'));
  const saved = new Map(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => { db.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } await fs.rm(root, { recursive: true, force: true }); });
  const values = new Map<string, string>(), events = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), length: 0 },
    addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events), setInterval() {}, location: { reload() {} } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_: string, run: () => unknown) => run() } } });
  const snapshot = (ids: string[]) => ({ format: 'english-ai-local-backup', version: 1, memoryStorage: 'indexedDB', exportedAt: '2026-10-17T00:00:00Z',
    localStorage: { 'english-ai:v2:articles': JSON.stringify(ids.map(id => ({ id, title: id, content: ['Text.'], status: 'Completed' }))) },
    indexedDb: { name: 'english-ai-memory-v2', version: 1, stores: Object.fromEntries(MEMORY_TABLES.map(table => [table, []])) } });
  const { profile } = db.bootstrap(snapshot(['computer'])); values.set('readage:local-database-profile:v1', profile.id);
  const { configureLocalDatabaseTransport } = await import('../src/lib/platform/localDatabaseTransport');
  let concurrent = false;
  configureLocalDatabaseTransport({ kind: 'native', async request(command, raw: any) {
    const body = raw ?? {};
    try {
      let result: any;
      if (command === 'status') result = { enabled: true };
      else if (command === 'bootstrap') result = db.bootstrap(body.source, body.preferredId);
      else if (command === 'query') result = db.query(body.profileId, body.table, body.key);
      else if (command === 'snapshot') {
        result = db.snapshot(body.profileId);
        if (concurrent) { concurrent = false; db.commit(profile.id, db.profile(profile.id).revision, [{ table: 'settings', key: 'english-ai:v2:other-writer', value: 'true' }]); }
      } else if (command === 'restore') result = db.restore(body.profileId, body.revision, body.backup);
      else throw new Error(command);
      return { status: 200, body: result };
    } catch (error) { return { status: error instanceof LocalDatabaseConflict ? 409 : 400, body: { error: (error as Error).message } }; }
  } });
  const { initializeLocalDatabase } = await import('../src/lib/localDatabase');
  const { mergeLocalDataBackup, mergeLocalDataBackupBatch } = await import('../src/lib/localDataBackup');
  await initializeLocalDatabase();
  await mergeLocalDataBackup(snapshot(['phone']));
  const read = () => JSON.parse(db.snapshot(profile.id).localStorage['english-ai:v2:articles']);
  assert.deepEqual(read().map((row: any) => row.id), ['computer', 'phone']);
  assert.equal(JSON.parse(db.previousSnapshot(profile.id).localStorage['english-ai:v2:articles']).length, 1);
  const revision = db.profile(profile.id).revision;
  await mergeLocalDataBackup(snapshot(['phone'])); assert.equal(read().length, 2);
  assert.equal(db.profile(profile.id).revision, revision);
  assert.equal(JSON.parse(db.previousSnapshot(profile.id).localStorage['english-ai:v2:articles']).length, 1);
  const recovery = db.previousSnapshot(profile.id);
  concurrent = true;
  await assert.rejects(mergeLocalDataBackup(snapshot(['new-word-device'])));
  assert.equal(read().length, 2); assert.equal(db.settings(profile.id)['english-ai:v2:other-writer'], 'true');
  assert.deepEqual(db.previousSnapshot(profile.id).localStorage, recovery.localStorage);

  // A conflict in the last selected file must leave even the first source unapplied.
  const conflict = snapshot(['phone']);
  conflict.localStorage['english-ai:v2:articles'] = JSON.stringify([{ id: 'phone', title: 'phone', content: ['Different text.'], status: 'Completed' }]);
  const beforeBatch = db.snapshot(profile.id), beforeRevision = db.profile(profile.id).revision;
  await assert.rejects(mergeLocalDataBackupBatch([snapshot(['tablet']), conflict]), /正文或原文件不同/);
  assert.deepEqual(db.snapshot(profile.id).localStorage, beforeBatch.localStorage);
  assert.deepEqual(db.snapshot(profile.id).indexedDb, beforeBatch.indexedDb);
  assert.equal(db.profile(profile.id).revision, beforeRevision);
  assert.deepEqual(db.previousSnapshot(profile.id), recovery);
  await assert.rejects(mergeLocalDataBackupBatch([]), /请先导入并选择备份/);

  await mergeLocalDataBackupBatch([snapshot(['tablet']), snapshot(['laptop'])]);
  assert.deepEqual(read().map((row: any) => row.id), ['computer', 'phone', 'tablet', 'laptop']);
  assert.equal(db.profile(profile.id).revision, beforeRevision + 1, 'all sources are committed in one restore');
  assert.deepEqual(db.previousSnapshot(profile.id).localStorage, beforeBatch.localStorage, 'recovery is the state before the entire batch');
  const batchRecovery = db.previousSnapshot(profile.id);
  const mergedRevision = db.profile(profile.id).revision;
  await mergeLocalDataBackupBatch([snapshot(['tablet']), snapshot(['laptop'])]);
  assert.equal(db.profile(profile.id).revision, mergedRevision);
  assert.deepEqual(db.previousSnapshot(profile.id), batchRecovery);
});
