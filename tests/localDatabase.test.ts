import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { LocalLearningDatabase, LocalDatabaseConflict } from '../server/localDatabase/store';
import { createFullBackup, restoreFullBackup } from '../server/localDatabase/bundle';
import { authorizeLocalDataRequest, createLocalDataRouter, localDatabaseEnabled } from '../server/localDatabase/routes';
import { LOCAL_DATA_HEADER, MEMORY_TABLES, type LocalArticleMetadataChange } from '../src/lib/localDatabaseProtocol';
import type { LocalDataBackup } from '../src/lib/localDataBackup';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';

const state = submitFsrsReview(initializeWordMemory('u', 'serendipity'), 'Good', new Date('2026-09-01T12:00:00Z'));
const articleEvidence = { userId: 'u', wordId: 'serendipity', articleId: 'article', localDate: '2026-09-02',
  validExposureCount: 1, clickedOccurrenceCount: 1, firstSeenAt: '2026-09-02T01:00:00Z', lastSeenAt: '2026-09-02T01:00:00Z' };
const source = (): LocalDataBackup => ({ format: 'english-ai-local-backup', version: 1, exportedAt: '2026-09-02T00:00:00Z', memoryStorage: 'indexedDB',
  localStorage: {
    'english-ai:v2:articles': '[{"id":"article","title":"原始文章","content":"Full text, 日本語 et français."}]',
    'english-ai:v2:sessions': '{ "article": {"chatMessages":[{"id":"chat","text":"keep exact bytes"}]} }',
    'english-ai:v2:readingBookmark': '{"articleId":"article","paragraphIndex":3}',
  }, indexedDb: { name: 'english-ai-memory-v2', version: 1, stores: {
    ...Object.fromEntries(MEMORY_TABLES.map(table => [table, []])),
    memoryState: [{ key: 'u|serendipity', state }],
    rawEvents: [{ key: 'u|serendipity|2026-09-02', events: [{ userId: 'u', wordId: 'serendipity', articleId: 'article', occurrenceId: 'p1', eventType: 'click', occurredAt: '2026-09-02T01:00:00Z', localDate: '2026-09-02' }] }],
    articleEvidence: [{ key: 'u|serendipity|article|2026-09-02', evidence: { ...articleEvidence } }],
    dailyEvidence: [{ key: 'u|serendipity|2026-09-02', evidence: { userId: 'u', wordId: 'serendipity', localDate: '2026-09-02',
      finalizedAt: null, articleEvidence: [{ ...articleEvidence }], articleCount: 1, validExposureCount: 1, clickedOccurrenceCount: 1, pendingGrade: 'Again' } }],
    finalizationTasks: [{ key: 'u|2026-09-02', task: { userId: 'u', localDate: '2026-09-02', wordIds: ['serendipity'], createdAt: '2026-09-02T01:00:00Z' } }],
    meta: [{ key: 'flashcard-settings:u', value: { dailyNewWordLimit: 20, suspended: ['preserve'] } }],
  } } });
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-sqlite-test-'));
  const filename = path.join(directory, 'learning.sqlite');
  const database = new LocalLearningDatabase(filename);
  t.after(async () => {
    database.close();
    // Only remove this test-owned, resolved temporary directory.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-sqlite-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, filename, database };
}
function equivalent(actual: LocalDataBackup, expected: LocalDataBackup) {
  assert.deepEqual(actual.localStorage, expected.localStorage);
  for (const table of MEMORY_TABLES) assert.deepEqual(actual.indexedDb?.stores[table], expected.indexedDb?.stores[table] ?? []);
}

test('SQLite migration preserves all memory stores, FSRS dates and exact application strings across reopen', async t => {
  const { database, filename } = await fixture(t);
  const original = source();
  const migrated = database.bootstrap(original);
  assert.equal(migrated.migrated, true);
  equivalent(database.snapshot(migrated.profile.id), original);
  assert.equal(database.bootstrap({ ...original, exportedAt: new Date().toISOString() }).profile.id, migrated.profile.id);
  assert.equal(database.bootstrap(undefined, migrated.profile.id).profile.id, migrated.profile.id);
  assert.equal(database.profiles().length, 1);
  const reopened = new LocalLearningDatabase(filename);
  try { equivalent(reopened.snapshot(migrated.profile.id), original); } finally { reopened.close(); }
  equivalent(original, source());
});

test('different browser archives stay isolated while a fresh browser shares the first profile', async t => {
  const { database } = await fixture(t);
  const first = database.bootstrap(source());
  const other = source(); other.localStorage['english-ai:v2:articles'] = '[{"id":"different"}]';
  const second = database.bootstrap(other);
  assert.notEqual(second.profile.id, first.profile.id);
  equivalent(database.snapshot(first.profile.id), source());
  const empty = source(); empty.localStorage = {}; empty.indexedDb!.stores = Object.fromEntries(MEMORY_TABLES.map(table => [table, []]));
  empty.indexedDb!.stores.meta = [{ key: 'warmup', value: true }];
  assert.equal(database.bootstrap(empty).profile.id, first.profile.id);
  assert.throws(() => database.bootstrap(source(), randomUUID()), /未找到/);
  assert.equal(database.profiles().length, 2);
});

test('migration verification rejects duplicate or unsupported records without partially changing a profile', async t => {
  const { database } = await fixture(t);
  const duplicate = source(); duplicate.indexedDb!.stores.memoryState.push({ key: 'u|serendipity', state: { ...state, stability: 999 } });
  assert.throws(() => database.bootstrap(duplicate), /重复记录/);
  assert.equal(database.profiles().length, 0);
  const unknown = source(); unknown.indexedDb!.stores.futureStore = [{ key: 'future', value: 1 }];
  assert.throws(() => database.bootstrap(unknown), /无法识别/);
  assert.equal(database.profiles().length, 0);
});

test('stale writes conflict and rebase; retried acknowledged transactions never apply twice', async t => {
  const { database, filename } = await fixture(t);
  const { profile } = database.bootstrap(source());
  const other = new LocalLearningDatabase(filename);
  try {
    const initial = profile.revision;
    const operation = randomUUID();
    const changes = [{ table: 'settings' as const, key: 'english-ai:v2:count', value: '1' }];
    const next = database.commit(profile.id, initial, changes, operation);
    assert.throws(() => other.commit(profile.id, initial, [{ ...changes[0], value: '2' }]), LocalDatabaseConflict);
    assert.equal(database.commit(profile.id, initial, changes, operation), next);
    assert.throws(() => database.commit(profile.id, next, [{ ...changes[0], value: '999' }], operation), /不一致/);
    other.commit(profile.id, next, [{ ...changes[0], value: '2' }]);
    assert.equal(database.settings(profile.id)['english-ai:v2:count'], '2');
    assert.equal(database.operationCommitted(profile.id, operation), true);
    const before = database.snapshot(profile.id);
    assert.throws(() => database.commit(profile.id, next + 1, [{ ...changes[0], value: '3' }, { table: 'settings', key: 'english-ai:v2:articles', value: '{broken' }]));
    equivalent(database.snapshot(profile.id), before);
    assert.equal(database.profile(profile.id).revision, next + 1);
  } finally { other.close(); }
});

test('exact-key batches return only requested rows within the selected profile and revision', async t => {
  const { database } = await fixture(t);
  const { profile } = database.bootstrap(source());
  const other = source(); other.localStorage['english-ai:v2:sessions'] = '{}';
  other.indexedDb!.stores.memoryState = [{ key: 'u|serendipity', state: { ...state, stability: 999 } }];
  database.bootstrap(other);
  const revision = database.commit(profile.id, profile.revision, [
    { table: 'memoryState', key: 'u|unrequested', value: { state: { ...state, wordId: 'unrequested' } } },
    { table: 'meta', key: 'u|serendipity', value: { value: 'different store' } },
  ]);
  assert.deepEqual(database.queryKeys(profile.id, 'memoryState', ['u|missing', 'u|serendipity', 'u|serendipity']), {
    revision, rows: [{ key: 'u|serendipity', value: { state } }],
  });
  assert.deepEqual(database.queryKeys(profile.id, 'memoryState', []), { revision, rows: [] });
  assert.equal(database.queryKeys(profile.id, 'memoryState', Array(500).fill('u|serendipity')).rows.length, 1);
  assert.throws(() => database.queryKeys(profile.id, 'memoryState', Array(501).fill('u|serendipity')), /批量查询参数/);
});

test('queries and nested snapshots can read committed data while another connection holds the writer lock', async t => {
  const { database, filename } = await fixture(t);
  const { profile } = database.bootstrap(source());
  const writer = new DatabaseSync(filename);
  try {
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('UPDATE profiles SET revision = revision + 1 WHERE id = ?').run(profile.id);
    writer.prepare("UPDATE records SET payload = ? WHERE profile_id = ? AND store = 'memoryState' AND key = ?")
      .run(JSON.stringify({ state: { ...state, stability: 999 } }), profile.id, 'u|serendipity');
    const expected = { revision: profile.revision, rows: [{ key: 'u|serendipity', value: { state } }] };
    assert.deepEqual(database.query(profile.id, 'memoryState', 'u|serendipity'), expected);
    assert.deepEqual(database.queryKeys(profile.id, 'memoryState', ['u|serendipity']), expected);
    assert.deepEqual(database.settingsSince(profile.id, profile.revision), { revision: profile.revision, rows: [], deletedKeys: [], reset: false });
    equivalent(database.snapshot(profile.id), source());
  } finally { writer.exec('ROLLBACK'); writer.close(); }
});

test('identical commits keep the revision and durable operation receipt without rewriting the article index', async t => {
  const { database, filename } = await fixture(t);
  const original = source(), { profile } = database.bootstrap(original);
  const observer = new DatabaseSync(filename);
  try {
    observer.exec(`CREATE TABLE article_updates (id TEXT);
      CREATE TRIGGER observe_article_updates AFTER UPDATE ON articles BEGIN INSERT INTO article_updates VALUES (NEW.id); END;
      CREATE TRIGGER observe_article_inserts AFTER INSERT ON articles BEGIN INSERT INTO article_updates VALUES (NEW.id); END;
      CREATE TRIGGER observe_article_deletes AFTER DELETE ON articles BEGIN INSERT INTO article_updates VALUES (OLD.id); END;`);
    const operation = randomUUID();
    const changes = [{ table: 'settings' as const, key: 'english-ai:v2:articles', value: original.localStorage['english-ai:v2:articles'] }];
    assert.equal(database.commit(profile.id, profile.revision, changes, operation), profile.revision);
    assert.equal(database.operationCommitted(profile.id, operation), true);
    assert.equal(database.commit(profile.id, profile.revision, [{ table: 'settings', key: 'english-ai:v2:absent', value: null, deleted: true }]), profile.revision);
    assert.equal(database.commit(profile.id, profile.revision, [], randomUUID()), profile.revision);
    assert.equal(observer.prepare('SELECT count(*) AS count FROM article_updates').get()!.count, 0);
    const next = database.commit(profile.id, profile.revision, [{ table: 'settings', key: 'english-ai:v2:count', value: '1' }]);
    assert.equal(database.commit(profile.id, profile.revision, changes, operation), next);
    assert.throws(() => database.commit(profile.id, next, [{ ...changes[0], value: '[]' }], operation), /不一致/);
  } finally { observer.close(); }
});

test('article index changes only touched articles and removes missing IDs atomically', async t => {
  const { database, filename } = await fixture(t);
  const original = source();
  original.localStorage['english-ai:v2:articles'] = JSON.stringify([
    { id: 'kept', title: 'Untouched', content: 'body stays exactly the same' },
    { id: 'changed', title: 'Before', content: 'second body' }, { id: 'removed', title: 'Removed', content: 'third body' },
  ]);
  const { profile } = database.bootstrap(original);
  const observer = new DatabaseSync(filename);
  try {
    observer.exec(`CREATE TABLE article_updates (action TEXT, id TEXT);
      CREATE TRIGGER observe_article_updates AFTER UPDATE ON articles BEGIN INSERT INTO article_updates VALUES ('update', NEW.id); END;
      CREATE TRIGGER observe_article_inserts AFTER INSERT ON articles BEGIN INSERT INTO article_updates VALUES ('insert', NEW.id); END;
      CREATE TRIGGER observe_article_deletes AFTER DELETE ON articles BEGIN INSERT INTO article_updates VALUES ('delete', OLD.id); END;`);
    const articles = [{ id: 'kept', title: 'Untouched', content: 'body stays exactly the same' },
      { id: 'changed', title: 'After', content: 'second body' }, { id: 'added', title: 'Added', content: 'new body' }];
    const revision = database.commit(profile.id, profile.revision, [{ table: 'settings', key: 'english-ai:v2:articles', value: JSON.stringify(articles) }]);
    assert.deepEqual(observer.prepare('SELECT action, id FROM article_updates ORDER BY id').all().map(row => ({ ...row })), [
      { action: 'insert', id: 'added' }, { action: 'update', id: 'changed' }, { action: 'delete', id: 'removed' },
    ]);
    assert.deepEqual(observer.prepare('SELECT payload FROM articles WHERE profile_id = ? ORDER BY id').all(profile.id).map(row => JSON.parse(String(row.payload))),
      [...articles].sort((a, b) => a.id.localeCompare(b.id)));
    assert.throws(() => database.commit(profile.id, revision, [{ table: 'settings', key: 'english-ai:v2:articles', value: '[{}]' }]));
    assert.equal(database.profile(profile.id).revision, revision);
    assert.equal(observer.prepare('SELECT count(*) AS count FROM article_updates').get()!.count, 3);
  } finally { observer.close(); }
});

test('article metadata overlays preserve base bytes, materialize all reads and survive reopen with idempotent commits', async t => {
  const { database, filename } = await fixture(t);
  const original = source();
  original.localStorage['english-ai:v2:articles'] = '[ { "id": "article", "title": "Original", "content": "Keep exact body, 日本語.", "importEnrichmentError": "old failure" }, { "id": "other", "title": "Other", "content": "untouched body" } ]';
  const { profile } = database.bootstrap(original);
  const operation = randomUUID();
  const change: LocalArticleMetadataChange = { table: 'settings', key: 'english-ai:v2:articles', articleMetadata: [
    { id: 'article', values: { lastOpenedAt: '2026-10-09T03:00:00Z', status: 'In Progress', importEnrichmentStatus: 'ready' }, deletedFields: ['importEnrichmentError'] },
  ] };
  const revision = database.commit(profile.id, profile.revision, [change], operation);
  assert.equal(revision, profile.revision + 1);
  const expected = JSON.parse(original.localStorage['english-ai:v2:articles']);
  Object.assign(expected[0], change.articleMetadata[0].values); delete expected[0].importEnrichmentError;
  const effective = JSON.stringify(expected);
  const observer = new DatabaseSync(filename);
  try {
    assert.equal(JSON.parse(String(observer.prepare("SELECT payload FROM records WHERE profile_id = ? AND store = 'settings' AND key = 'english-ai:v2:articles'").get(profile.id)!.payload)), original.localStorage['english-ai:v2:articles']);
    assert.equal(observer.prepare('SELECT count(*) AS count FROM article_metadata WHERE profile_id = ?').get(profile.id)!.count, 1);
    assert.deepEqual(observer.prepare('SELECT payload FROM articles WHERE profile_id = ? AND id = ?').get(profile.id, 'article')!.payload, JSON.stringify(expected[0]));
  } finally { observer.close(); }
  assert.equal(database.settings(profile.id)['english-ai:v2:articles'], effective);
  assert.equal(database.query(profile.id, 'settings', 'english-ai:v2:articles').rows[0].value, effective);
  assert.equal(database.queryKeys(profile.id, 'settings', ['english-ai:v2:articles']).rows[0].value, effective);
  assert.equal(database.snapshot(profile.id).localStorage['english-ai:v2:articles'], effective);
  assert.deepEqual(database.settingsSince(profile.id, profile.revision), { revision, rows: [{ key: 'english-ai:v2:articles', value: effective }], deletedKeys: [], reset: false });
  assert.equal(database.commit(profile.id, profile.revision, [change], operation), revision);
  const noopOperation = randomUUID();
  assert.equal(database.commit(profile.id, revision, [change], noopOperation), revision);
  assert.equal(database.operationCommitted(profile.id, noopOperation), true);
  assert.throws(() => database.commit(profile.id, profile.revision, [change]), LocalDatabaseConflict);
  assert.throws(() => database.commit(profile.id, revision, [{ ...change, articleMetadata: [{ id: 'article', values: { status: 'Completed' }, deletedFields: [] }] }], operation), /不一致/);
  const second: LocalArticleMetadataChange = { ...change, articleMetadata: [
    { id: 'article', values: { status: 'Completed', importEnrichmentError: 'new failure' }, deletedFields: ['importEnrichmentStatus'] },
  ] };
  const updatedRevision = database.commit(profile.id, revision, [second]);
  Object.assign(expected[0], second.articleMetadata[0].values); delete expected[0].importEnrichmentStatus;
  assert.deepEqual(JSON.parse(database.settings(profile.id)['english-ai:v2:articles']), expected);
  // A lost acknowledgement of an earlier patch must not restore stale metadata.
  assert.equal(database.commit(profile.id, profile.revision, [change], operation), updatedRevision);
  assert.deepEqual(JSON.parse(database.settings(profile.id)['english-ai:v2:articles']), expected);
  const third: LocalArticleMetadataChange = { ...change, articleMetadata: [
    { id: 'article', values: { importEnrichmentStatus: 'pending' }, deletedFields: ['lastOpenedAt'] },
  ] };
  database.commit(profile.id, updatedRevision, [third]);
  Object.assign(expected[0], third.articleMetadata[0].values); delete expected[0].lastOpenedAt;
  assert.deepEqual(JSON.parse(database.settings(profile.id)['english-ai:v2:articles']), expected);
  const reopened = new LocalLearningDatabase(filename);
  try {
    assert.deepEqual(JSON.parse(reopened.settings(profile.id)['english-ai:v2:articles']), expected);
    assert.equal(reopened.operationCommitted(profile.id, operation), true);
  } finally { reopened.close(); }
});

test('full article replacements and restores clear metadata overlays without losing recovery history', async t => {
  const { database, filename } = await fixture(t);
  const original = source(), { profile } = database.bootstrap(original);
  const metadata: LocalArticleMetadataChange = { table: 'settings', key: 'english-ai:v2:articles', articleMetadata: [
    { id: 'article', values: { lastOpenedAt: '2026-10-09T03:00:00Z' }, deletedFields: [] },
  ] };
  let revision = database.commit(profile.id, profile.revision, [metadata]);
  const history = database.snapshot(profile.id);
  const restored = database.restore(profile.id, revision, original); revision = restored.revision;
  equivalent(database.previousSnapshot(profile.id), history);
  equivalent(database.snapshot(profile.id), original);
  const observer = new DatabaseSync(filename);
  try {
    assert.equal(observer.prepare('SELECT count(*) AS count FROM article_metadata').get()!.count, 0);
    revision = database.commit(profile.id, revision, [metadata]);
    // Base bytes are identical; removing the overlay is still an effective change.
    revision = database.commit(profile.id, revision, [{ table: 'settings', key: 'english-ai:v2:articles', value: original.localStorage['english-ai:v2:articles'] }]);
    assert.equal(observer.prepare('SELECT count(*) AS count FROM article_metadata').get()!.count, 0);
    equivalent(database.snapshot(profile.id), original);
    assert.deepEqual(JSON.parse(String(observer.prepare('SELECT payload FROM articles WHERE profile_id = ? AND id = ?').get(profile.id, 'article')!.payload)),
      JSON.parse(original.localStorage['english-ai:v2:articles'])[0]);
    revision = database.commit(profile.id, revision, [metadata]);
    database.commit(profile.id, revision, [{ table: 'settings', key: 'english-ai:v2:articles', value: '[]' }]);
    assert.equal(observer.prepare('SELECT count(*) AS count FROM article_metadata').get()!.count, 0);
    assert.equal(observer.prepare('SELECT count(*) AS count FROM articles WHERE profile_id = ?').get(profile.id)!.count, 0);
  } finally { observer.close(); }
});

test('malformed or cross-profile article metadata updates fail atomically before changing history', async t => {
  const { database } = await fixture(t);
  const original = source(), { profile } = database.bootstrap(original);
  const otherSource = source(); otherSource.localStorage['english-ai:v2:articles'] = '[{"id":"other-profile","title":"Isolated","content":"keep"}]';
  const other = database.bootstrap(otherSource).profile;
  const metadata = (patch: unknown) => ({ table: 'settings', key: 'english-ai:v2:articles', articleMetadata: [patch] }) as LocalArticleMetadataChange;
  for (const change of [
    metadata({ id: 'article', values: { content: 'overwrite body' }, deletedFields: [] }),
    metadata({ id: 'article', values: {}, deletedFields: ['title'] }),
    metadata({ id: 'article', values: { status: 'Completed' }, deletedFields: ['status'] }),
    metadata({ id: 'article', values: [], deletedFields: [] }),
    metadata({ id: 'article', values: { status: undefined }, deletedFields: [] }),
    metadata({ id: 'article', values: {}, deletedFields: 'status' }),
    metadata({ id: 'other-profile', values: { status: 'Completed' }, deletedFields: [] }),
    { ...metadata({ id: 'article', values: {}, deletedFields: [] }), value: '[]' },
  ]) assert.throws(() => database.commit(profile.id, profile.revision, [change]));
  const first = { id: 'article', values: { status: 'Completed' }, deletedFields: [] };
  assert.throws(() => database.commit(profile.id, profile.revision, [{ ...metadata(first), articleMetadata: [first,
    { id: 'missing', values: { status: 'Completed' }, deletedFields: [] }] }]));
  assert.equal(database.profile(profile.id).revision, profile.revision);
  equivalent(database.snapshot(profile.id), original);
  equivalent(database.snapshot(other.id), otherSource);
});

test('settings deltas coalesce changes, carry deletions, isolate profiles and reset after restore', async t => {
  const { database } = await fixture(t);
  const { profile } = database.bootstrap(source());
  const otherSource = source(); otherSource.localStorage['english-ai:v2:sessions'] = '{}';
  const other = database.bootstrap(otherSource).profile;
  let revision = database.commit(profile.id, profile.revision, [{ table: 'meta', key: 'memory-only', value: { value: true } }]);
  assert.deepEqual(database.settingsSince(profile.id, profile.revision), { revision, rows: [], deletedKeys: [], reset: false });
  revision = database.commit(profile.id, revision, [
    { table: 'settings', key: 'english-ai:v2:count', value: '1' },
    { table: 'settings', key: 'english-ai:v2:readingBookmark', value: null, deleted: true },
  ]);
  revision = database.commit(profile.id, revision, [{ table: 'settings', key: 'english-ai:v2:count', value: '2' }]);
  assert.deepEqual(database.settingsSince(profile.id, profile.revision), { revision, rows: [{ key: 'english-ai:v2:count', value: '2' }],
    deletedKeys: ['english-ai:v2:readingBookmark'], reset: false });
  assert.deepEqual(database.settingsSince(other.id, other.revision), { revision: other.revision, rows: [], deletedKeys: [], reset: false });
  const replacement = source(); replacement.localStorage = { 'english-ai:v2:articles': '[]' };
  const restored = database.restore(profile.id, revision, replacement);
  assert.deepEqual(database.settingsSince(profile.id, revision), { revision: restored.revision, rows: [{ key: 'english-ai:v2:articles', value: '[]' }], deletedKeys: [], reset: true });
  assert.deepEqual(database.settingsSince(profile.id, restored.revision), { revision: restored.revision, rows: [], deletedKeys: [], reset: false });
  const previous = source(); previous.localStorage['english-ai:v2:count'] = '2'; delete previous.localStorage['english-ai:v2:readingBookmark'];
  previous.indexedDb!.stores.meta.push({ key: 'memory-only', value: true });
  equivalent(database.previousSnapshot(profile.id), previous);
});

test('populated version-one profiles upgrade additively with a full snapshot fallback', async t => {
  const { directory } = await fixture(t);
  const filename = path.join(directory, 'version-one.sqlite');
  const initial = new LocalLearningDatabase(filename);
  const { profile } = initial.bootstrap(source());
  initial.close();
  const legacy = new DatabaseSync(filename);
  legacy.exec('DROP TABLE article_metadata; DROP TABLE settings_changes; DROP TABLE settings_sync; PRAGMA user_version = 1;');
  legacy.close();
  const upgraded = new LocalLearningDatabase(filename);
  try {
    equivalent(upgraded.snapshot(profile.id), source());
    const observer = new DatabaseSync(filename);
    try { assert.equal(observer.prepare('PRAGMA user_version').get()!.user_version, 2); } finally { observer.close(); }
    assert.equal(upgraded.settingsSince(profile.id, 0).reset, true);
    assert.deepEqual(upgraded.settingsSince(profile.id, 0).rows, upgraded.query(profile.id, 'settings').rows);
    assert.deepEqual(upgraded.settingsSince(profile.id, profile.revision), { revision: profile.revision, rows: [], deletedKeys: [], reset: false });
    const revision = upgraded.commit(profile.id, profile.revision, [{ table: 'settings', key: 'english-ai:v2:new', value: 'true' }]);
    assert.deepEqual(upgraded.settingsSince(profile.id, profile.revision), { revision, rows: [{ key: 'english-ai:v2:new', value: 'true' }], deletedKeys: [], reset: false });
  } finally { upgraded.close(); }
});

test('restore is atomic, isolates profiles, and exposes the complete previous archive', async t => {
  const { database } = await fixture(t);
  const { profile } = database.bootstrap(source());
  const other = source(); other.localStorage['english-ai:v2:sessions'] = '{}';
  const second = database.bootstrap(other);
  const replacement = source(); replacement.localStorage = { 'english-ai:v2:articles': '[]' }; replacement.indexedDb!.stores.memoryState = [];
  const invalid = structuredClone(replacement); invalid.localStorage['english-ai:v2:articles'] = '{broken';
  assert.throws(() => database.restore(profile.id, profile.revision, invalid));
  assert.throws(() => database.previousSnapshot(profile.id), /尚未导入/);
  equivalent(database.snapshot(profile.id), source());
  database.restore(profile.id, profile.revision, replacement);
  equivalent(database.snapshot(profile.id), replacement);
  equivalent(database.previousSnapshot(profile.id), source());
  equivalent(database.snapshot(second.profile.id), other);
  assert.throws(() => database.restore(profile.id, profile.revision, source()), LocalDatabaseConflict);
});

test('invalid memory backup records preserve the profile revision, complete data and recovery history', async t => {
  const { database } = await fixture(t);
  const original = source(), { profile } = database.bootstrap(original);
  const malformed: Array<[string, unknown]> = [
    ['memoryState', { key: 'u|serendipity', state: null }],
    ['memoryState', { key: 'u|serendipity' }],
    ['memoryState', { key: 'u|different', state }],
    ['memoryState', { key: 'u|serendipity', state: { ...state, fsrsCard: {} } }],
    ['memoryState', { key: 'u|serendipity', state: { ...state, fsrsCard: { ...state.fsrsCard, state: 99 } } }],
    ['memoryState', { key: 'u|serendipity', state: { ...state, fsrsReviews: [null] } }],
    ['memoryState', { key: 'u|serendipity', state: { ...state, fsrsReviews: [{ ...state.fsrsReviews[0], state: 99 }] } }],
    ['memoryState', { key: 'u|serendipity', state: { ...state, rme: { contextHistory: [1] } } }],
    ['rawEvents', { key: 'u|serendipity|2026-09-02', events: {} }],
    ['rawEvents', { key: 'u|different|2026-09-02', events: (original.indexedDb!.stores.rawEvents[0] as any).events }],
    ['rawEvents', { key: 'u|serendipity|2026-09-02', events: [{ ...(original.indexedDb!.stores.rawEvents[0] as any).events[0], eventType: ['click'] }] }],
    ['articleEvidence', { key: 'u|different|article|2026-09-02', evidence: articleEvidence }],
    ['articleEvidence', { key: 'u|serendipity|article|2026-09-02', evidence: null }],
    ['dailyEvidence', { key: 'u|serendipity|2026-09-02', evidence: { ...(original.indexedDb!.stores.dailyEvidence[0] as any).evidence, articleEvidence: [null] } }],
    ['dailyEvidence', { key: 'u|serendipity|2026-09-03', evidence: (original.indexedDb!.stores.dailyEvidence[0] as any).evidence }],
    ['finalizationTasks', { key: 'u|2026-09-03', task: (original.indexedDb!.stores.finalizationTasks[0] as any).task }],
    ['finalizationTasks', { key: 'u|2026-09-02', task: { userId: 'u', localDate: '2026-09-02', createdAt: '2026-09-02T00:00:00Z', wordIds: null } }],
    ['meta', { key: 'missing-value' }],
  ];
  for (const [table, row] of malformed) {
    const backup = structuredClone(original); backup.indexedDb!.stores[table] = [row];
    assert.throws(() => database.restore(profile.id, profile.revision, backup), /记录无效/);
    assert.equal(database.profile(profile.id).revision, profile.revision);
    equivalent(database.snapshot(profile.id), original);
    assert.throws(() => database.previousSnapshot(profile.id), /尚未导入/);
    assert.throws(() => database.bootstrap(backup), /记录无效/);
    assert.equal(database.profiles().length, 1);
  }
});

test('valid historical memory restores with optional fields absent and generic metadata intact across reopen', async t => {
  const { database, filename } = await fixture(t);
  const { profile } = database.bootstrap(source());
  const backup = source();
  const legacyState: any = structuredClone(state);
  delete legacyState.fsrsCard.learningSteps;
  legacyState.fsrsReviews.forEach((review: any) => { delete review.learningSteps; delete review.source; });
  legacyState.rme = null;
  legacyState.extraHistoricalField = { preserved: true };
  backup.indexedDb!.stores.memoryState = [{ key: 'u|serendipity', state: legacyState }];
  backup.indexedDb!.stores.meta.push({ key: 'generic', value: ['old', 1] }, { key: 'nullable', value: null });
  database.restore(profile.id, profile.revision, backup);
  equivalent(database.snapshot(profile.id), backup);
  equivalent(database.previousSnapshot(profile.id), source());
  const reopened = new LocalLearningDatabase(filename);
  try { equivalent(reopened.snapshot(profile.id), backup); } finally { reopened.close(); }
  assert.ok(submitFsrsReview(legacyState, 3, new Date('2026-09-03T12:00:00Z')).fsrsReviews.length > legacyState.fsrsReviews.length);
});

for (const version of [3, 4] as const) test(`SQLite round-trips policy v${version} learning, relearning and mixed policy history without changing their due dates`, async t => {
  const { database, filename } = await fixture(t);
  const original = source();
  const at = new Date('2026-09-02T12:00:00.000Z');
  const policy = { version, desiredRetention: 0.95 };
  let learning = initializeWordMemory('u', 'serendipity');
  learning = submitFsrsReview(learning, 1, new Date('2026-09-01T11:00:00.000Z'), { version: 1, desiredRetention: 0.9 });
  learning = submitFsrsReview(learning, 2, new Date('2026-09-01T12:00:00.000Z'), { version: 2, desiredRetention: 0.9 });
  if (version === 4) learning = submitFsrsReview(learning, 1, new Date('2026-09-02T11:00:00.000Z'), { version: 3, desiredRetention: 0.93 });
  learning = submitFsrsReview(learning, 1, at, policy);
  let relearning = submitFsrsReview(initializeWordMemory('u', 'relearning'), 3, new Date('2026-09-01T12:00:00.000Z'));
  relearning = submitFsrsReview(relearning, 1, at, policy);
  assert.equal(learning.fsrsCard.state, 3);
  assert.equal(relearning.fsrsCard.state, 3);
  assert.ok([learning, relearning].every(state => Date.parse(state.nextReview) - at.getTime() < 86_400_000));
  const newLearning = submitFsrsReview(initializeWordMemory('u', 'learning'), 3, at, policy);
  assert.equal(newLearning.fsrsCard.state, 1);
  assert.ok(newLearning.fsrsCard.learningSteps > 0);
  const states = [learning, relearning, newLearning];
  if (version === 4) for (const state of states) assert.equal(state.nextReview, state.lastReview);
  original.indexedDb!.stores.memoryState = states.map(state => ({ key: `u|${state.wordId}`, state })).sort((left, right) => left.key.localeCompare(right.key));
  original.indexedDb!.stores.meta = [
    { key: 'extension-journal:["u","learning"]', value: { version: 1, userId: 'u', wordId: 'learning',
      baselineState: newLearning, baselineDaily: [], baselineRaw: [], events: [] } },
    { key: 'reading-verification:u', value: { version: 1, userId: 'u', attempts: states.map(state => ({
      attemptId: `intraday:${state.wordId}`, wordId: state.wordId, scheduling: policy,
    })) } },
  ];
  original.localStorage['english-ai:v2:memory:state:u:learning'] = JSON.stringify(newLearning);
  const { profile } = database.bootstrap(source());
  database.restore(profile.id, profile.revision, original);
  equivalent(database.snapshot(profile.id), original);
  const reopened = new LocalLearningDatabase(filename);
  try { equivalent(reopened.snapshot(profile.id), original); } finally { reopened.close(); }
  equivalent(database.previousSnapshot(profile.id), source());
  assert.deepEqual(learning.fsrsReviews.map(review => review.scheduling?.version), version === 4 ? [1, 2, 3, 4] : [1, 2, 3]);
});

test('SQLite restores v6 with mixed historical policies and preserves the previous snapshot across reopen', async t => {
  const { database, filename } = await fixture(t);
  const original = source();
  const { profile } = database.bootstrap(original);
  let reviewed = submitFsrsReview(initializeWordMemory('u', 'serendipity'), 3,
    new Date('2026-09-01T12:00:00Z'), { version: 1, desiredRetention: 0.9 });
  reviewed = submitFsrsReview(reviewed, 2, new Date('2026-09-02T12:00:00Z'), { version: 5, desiredRetention: 0.93 });
  const scheduling = { version: 6 as const, desiredRetention: 0.95 };
  reviewed = submitFsrsReview(reviewed, 3, new Date('2026-09-03T12:00:00Z'), scheduling);
  reviewed.fsrsCard.confirmationDue = '2026-09-04T12:00:00.000Z';
  const evidence = { kind: 'answer_rehearsal' as const, answerExposedAt: '2026-09-03T12:00:00.000Z' };
  reviewed = submitFsrsReview(reviewed, 3, new Date('2026-09-03T12:00:30Z'), scheduling, evidence);
  reviewed.fsrsCard.confirmationDue = '2026-09-04T12:00:00.000Z';
  assert.deepEqual(reviewed.fsrsReviews.map(review => review.scheduling?.version), [1, 5, 6, 6]);
  assert.equal(reviewed.fsrsCard.confirmationDue, '2026-09-04T12:00:00.000Z');
  assert.equal(reviewed.fsrsReviews.at(-1)?.modelApplied, false);
  assert.deepEqual(reviewed.fsrsReviews.at(-1)?.evidence, evidence);
  assert.equal(reviewed.fsrsReviews.at(-1)?.beforeCard?.confirmationDue, reviewed.fsrsCard.confirmationDue);
  const readingTask = { type: 'context_choice' as const, contextVisible: true as const,
    answerExposed: false, mapping: 'hard_on_correct' as const };
  const practiceTask = { ...readingTask, answerExposed: true, mapping: 'practice_only' as const };
  Object.assign(reviewed.fsrsReviews.at(-1)!, { readingTask: practiceTask });
  const restored = source();
  const practiceOnly = initializeWordMemory('u', 'practice-only');
  const beforePractice = { ...practiceOnly.fsrsCard };
  practiceOnly.fsrsCard.reps = 1;
  Object.assign(practiceOnly, { fsrsReviews: [{ ...reviewed.fsrsReviews.at(-1), state: 0, stability: 0, difficulty: 0,
    due: practiceOnly.fsrsCard.due, beforeCard: beforePractice }] });
  restored.indexedDb!.stores.memoryState = [{ key: 'u|practice-only', state: practiceOnly }, { key: 'u|serendipity', state: reviewed }];
  const verification = { version: 1, userId: 'u', attempts: [
    { attemptId: 'v6-recall', wordId: 'serendipity', scheduling, readingTask },
    { attemptId: 'v6-practice', wordId: 'practice-only', scheduling, readingTask: practiceTask },
    { attemptId: 'legacy-recall', wordId: 'serendipity' },
  ] };
  const extension = { version: 1, userId: 'u', wordId: 'serendipity', baselineState: reviewed,
    baselineDaily: [], baselineRaw: [], events: [] };
  restored.indexedDb!.stores.meta.push({ key: 'reading-verification:u', value: verification },
    { key: 'extension-journal:["u","serendipity"]', value: extension });
  restored.indexedDb!.stores.meta.sort((left: any, right: any) => left.key.localeCompare(right.key));
  restored.localStorage['english-ai:v2:memory:state:u:serendipity'] = JSON.stringify(reviewed);
  restored.localStorage['english-ai:v2:memory:meta:reading-verification:u'] = JSON.stringify(verification);
  restored.localStorage['english-ai:v2:memory:meta:extension-journal:["u","serendipity"]'] = JSON.stringify(extension);
  database.restore(profile.id, profile.revision, restored);
  const reopened = new LocalLearningDatabase(filename);
  try {
    equivalent(reopened.snapshot(profile.id), restored);
    equivalent(reopened.previousSnapshot(profile.id), original);
  } finally { reopened.close(); }
});

test('SQLite preserves scheduling audits and rejects corrupt snapshots or recall evidence without touching the profile', async t => {
  const { database } = await fixture(t);
  const original = source();
  const reviewed: any = (original.indexedDb!.stores.memoryState[0] as any).state = structuredClone(state);
  reviewed.fsrsReviews[0].scheduling = { version: 1, desiredRetention: 0.95 };
  reviewed.fsrsReviews[0].beforeCard = initializeWordMemory('u', 'serendipity').fsrsCard;
  (original.indexedDb!.stores.rawEvents[0] as any).events[0].lookupOnly = true;
  for (const table of ['articleEvidence', 'dailyEvidence']) (original.indexedDb!.stores[table][0] as any).evidence.recallFailureCount = 0;
  original.indexedDb!.stores.meta.push(
    { key: 'reading-verification:u', value: { version: 1, userId: 'u', attempts: [
      { attemptId: 'policy-v1', scheduling: { version: 1, desiredRetention: 0.95 } },
      { attemptId: 'policy-v2', scheduling: { version: 2, desiredRetention: 0.95 } },
      { attemptId: 'policy-v3', scheduling: { version: 3, desiredRetention: 0.95 } },
      { attemptId: 'policy-v4', scheduling: { version: 4, desiredRetention: 0.95 } }] } },
    { key: 'extension-journal:["u","serendipity"]', value: { version: 1, pendingFailureDates: ['2026-09-02'], baselineState: structuredClone(reviewed), baselineDaily: [], baselineRaw: [], events: [{ eventType: 'click', lookupOnly: true }] } });
  original.indexedDb!.stores.meta.sort((left: any, right: any) => left.key.localeCompare(right.key));
  const { profile } = database.bootstrap(original);
  equivalent(database.snapshot(profile.id), original);
  const corruptions = [
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.memoryState[0] as any).state.fsrsReviews[0].scheduling.desiredRetention = 0.905; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.memoryState[0] as any).state.fsrsReviews[0].beforeCard.reps = -1; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.memoryState[0] as any).state.fsrsReviews[0].beforeCard.state = 2; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.rawEvents[0] as any).events[0].lookupOnly = false; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.articleEvidence[0] as any).evidence.recallFailureCount = 2; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.dailyEvidence[0] as any).evidence.recallFailureCount = -1; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.meta.find((row: any) => row.key === 'reading-verification:u') as any).value.attempts[0].scheduling.desiredRetention = 0.905; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.meta.find((row: any) => row.key === 'reading-verification:u') as any).value.attempts[1].scheduling.version = 7; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.meta.find((row: any) => row.key.startsWith('extension-journal:')) as any).value.pendingFailureDates = ['2026-02-30']; },
    (backup: LocalDataBackup) => { (backup.indexedDb!.stores.meta.find((row: any) => row.key.startsWith('extension-journal:')) as any).value.events[0].lookupOnly = false; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(original); corrupt(candidate);
    assert.throws(() => database.restore(profile.id, profile.revision, candidate), /记录无效/);
    equivalent(database.snapshot(profile.id), original);
    assert.equal(database.profile(profile.id).revision, profile.revision);
    assert.throws(() => database.previousSnapshot(profile.id), /尚未导入/);
  }
});

test('newer SQLite schema versions are refused without altering the database', async t => {
  const { directory } = await fixture(t);
  const file = path.join(directory, 'future.sqlite');
  const future = new DatabaseSync(file); future.exec('PRAGMA user_version = 99'); future.close();
  assert.throws(() => new LocalLearningDatabase(file), /更新版本/);
  const reopened = new DatabaseSync(file);
  try { assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 99); } finally { reopened.close(); }
});

test('ZIP transfers referenced PDFs and both image locations, retaining older files and rollback records', async t => {
  const { directory, database } = await fixture(t);
  const original = source(); const from = path.join(directory, 'from'), to = path.join(directory, 'to');
  const assets = [
    { folder: 'documents', prefix: '/api/import/documents/', bytes: Buffer.from('%PDF-1.7\nlocal fixture\n%%EOF'), ext: 'pdf' },
    { folder: 'document_images', prefix: '/api/import/images/', bytes: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), ext: 'png' },
    { folder: 'assets', prefix: '/api/magazines/assets/', bytes: Buffer.from('GIF89a000000fixture'), ext: 'gif' },
  ];
  const urls: string[] = [];
  for (const asset of assets) {
    const name = `${createHash('sha256').update(asset.bytes).digest('hex')}.${asset.ext}`;
    await fs.mkdir(path.join(from, asset.folder), { recursive: true }); await fs.writeFile(path.join(from, asset.folder, name), asset.bytes);
    urls.push(asset.prefix + name);
  }
  original.localStorage['english-ai:v2:articles'] = JSON.stringify([{ id: 'article', title: 'with media', content: 'original body', sourceDocument: { src: urls[0] }, media: [{ src: urls[1] }, { src: urls[2] }] }]);
  const { profile } = database.bootstrap(source());
  await fs.mkdir(to, { recursive: true }); await fs.writeFile(path.join(to, 'keep.txt'), 'do not remove');
  const zip = await createFullBackup(original, from), bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await restoreFullBackup(database, profile.id, profile.revision, bytes, to);
  equivalent(database.snapshot(profile.id), original); equivalent(database.previousSnapshot(profile.id), source());
  for (const [index, asset] of assets.entries()) assert.deepEqual(await fs.readFile(path.join(to, asset.folder, path.basename(urls[index]))), asset.bytes);
  assert.equal(await fs.readFile(path.join(to, 'keep.txt'), 'utf8'), 'do not remove');
  const snapshot = database.snapshot(profile.id), revision = database.profile(profile.id).revision;
  zip.file('learning.json', JSON.stringify(source()));
  await assert.rejects(restoreFullBackup(database, profile.id, revision, await zip.generateAsync({ type: 'nodebuffer' }), to), /完整性核对/);
  equivalent(database.snapshot(profile.id), snapshot);
  const missing = structuredClone(original); missing.localStorage['english-ai:v2:articles'] = JSON.stringify([{ id: 'missing', media: [{ src: '/api/import/images/' + '0'.repeat(64) + '.png' }] }]);
  await assert.rejects(createFullBackup(missing, from), /缺失/);
});

test('modified, omitted and oversized ZIP attachments fail before replacing learning records', async t => {
  const { directory, database } = await fixture(t);
  const { profile } = database.bootstrap(source());
  const bytes = Buffer.from('GIF89a000000fixture'), digest = createHash('sha256').update(bytes).digest('hex');
  const root = path.join(directory, 'assets-root'); await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets', `${digest}.gif`), bytes);
  const original = source(); original.localStorage['english-ai:v2:articles'] = JSON.stringify([{ id: 'a', media: [{ src: `/api/magazines/assets/${digest}.gif` }] }]);
  const zip = await createFullBackup(original, root);
  zip.file(`assets/assets/${digest}.gif`, Buffer.from('GIF89a000000changed'));
  await assert.rejects(restoreFullBackup(database, profile.id, profile.revision, await zip.generateAsync({ type: 'nodebuffer' }), root), /完整性核对/);
  const omitted = await createFullBackup(original, root); const manifest = JSON.parse(await omitted.file('manifest.json')!.async('string'));
  manifest.assets = []; omitted.file('manifest.json', JSON.stringify(manifest));
  await assert.rejects(restoreFullBackup(database, profile.id, profile.revision, await omitted.generateAsync({ type: 'nodebuffer' }), root), /遗漏/);
  const oversized = await (await createFullBackup(source(), root)).generateAsync({ type: 'nodebuffer' });
  const central = oversized.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); oversized.writeUInt32LE(65 * 1024 * 1024, central + 24);
  await assert.rejects(restoreFullBackup(database, profile.id, profile.revision, oversized, root), /64 MiB/);
  const dishonest = await createFullBackup(source(), root);
  dishonest.file('learning.json', Buffer.alloc(65 * 1024 * 1024, 120));
  const dishonestBytes = await dishonest.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  const firstEntry = dishonestBytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  dishonestBytes.writeUInt32LE(16, firstEntry + 24);
  await assert.rejects(restoreFullBackup(database, profile.id, profile.revision, dishonestBytes, root), /64 MiB/);
  equivalent(database.snapshot(profile.id), source());
});

test('desktop API enforces loopback, exact origins and custom request headers, preserving public visitor isolation', async t => {
  assert.equal(localDatabaseEnabled('0.0.0.0', { NODE_ENV: 'development', LOCAL_DATABASE_ENABLED: 'true' }), false);
  assert.equal(localDatabaseEnabled('localhost', { NODE_ENV: 'production' }), false);
  assert.equal(localDatabaseEnabled('localhost', { NODE_ENV: 'production', LOCAL_DATABASE_ENABLED: 'true' }), true);
  const valid: any = { headers: { host: 'localhost:3000', [LOCAL_DATA_HEADER]: '1', origin: 'http://localhost:3000' }, socket: { remoteAddress: '127.0.0.1' }, protocol: 'http' };
  assert.equal(authorizeLocalDataRequest(valid), true);
  for (const headers of [{ ...valid.headers, origin: 'https://attacker.example' }, { ...valid.headers, host: 'attacker.example' }, { ...valid.headers, 'sec-fetch-site': 'cross-site' }, { host: 'localhost:3000' }]) assert.equal(authorizeLocalDataRequest({ ...valid, headers }), false);
  assert.equal(authorizeLocalDataRequest({ ...valid, socket: { remoteAddress: '192.168.1.5' } }), false);
  const { directory } = await fixture(t);
  const local = createLocalDataRouter({ host: '127.0.0.1', filename: path.join(directory, 'api.sqlite'), env: { NODE_ENV: 'development' } });
  const app = express(); app.use('/api/local-data', local.router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/local-data`;
  assert.equal((await fetch(`${url}/status`)).status, 403);
  const headers = { [LOCAL_DATA_HEADER]: '1', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${url}/status`, { headers })).status, 200);
  assert.equal((await fetch(`${url}/status`, { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
  const migrated = await (await fetch(`${url}/bootstrap`, { method: 'POST', headers, body: JSON.stringify({ source: source() }) })).json();
  const query = await (await fetch(`${url}/query`, { method: 'POST', headers, body: JSON.stringify({ profileId: migrated.profile.id, table: 'memoryState', prefix: 'u|' }) })).json();
  assert.deepEqual(query.rows[0].value.state, state);
  const batchBody = { profileId: migrated.profile.id, table: 'memoryState', keys: ['u|missing', 'u|serendipity'] };
  const batch = await fetch(`${url}/query`, { method: 'POST', headers, body: JSON.stringify(batchBody) });
  assert.equal(batch.status, 200);
  assert.deepEqual(await batch.json(), query);
  for (const body of [
    { ...batchBody, key: 'u|serendipity' }, { ...batchBody, prefix: 'u|' },
    { profileId: migrated.profile.id, table: 'memoryState', key: 'u|serendipity', prefix: 'u|' },
    { ...batchBody, keys: 'u|serendipity' }, { ...batchBody, keys: [1] },
    { ...batchBody, keys: Array(501).fill('u|serendipity') },
  ]) {
    assert.equal((await fetch(`${url}/query`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  const delta = await fetch(`${url}/settings-since`, { method: 'POST', headers, body: JSON.stringify({ profileId: migrated.profile.id, revision: query.revision }) });
  assert.equal(delta.status, 200);
  assert.deepEqual(await delta.json(), { revision: query.revision, rows: [], deletedKeys: [], reset: false });
  for (const revision of [-1, 0.5, '1']) {
    assert.equal((await fetch(`${url}/settings-since`, { method: 'POST', headers, body: JSON.stringify({ profileId: migrated.profile.id, revision }) })).status, 400);
  }
  const invalid = await fetch(`${url}/commit`, { method: 'POST', headers, body: JSON.stringify({ profileId: migrated.profile.id, revision: query.revision, changes: [{ table: 'settings', key: 'another-app', value: 'x' }] }) });
  assert.equal(invalid.status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); local.close(); }
});
