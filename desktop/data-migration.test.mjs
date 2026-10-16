import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hasLegacyDesktopData, inspectDesktopMigrationSource, inspectLearningDatabase, prepareDesktopData } from './data-migration.mjs';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readge-migration-test-'));
  const source = path.join(root, 'legacy');
  const target = path.join(root, 'user');
  await fs.mkdir(path.join(source, 'local-data/library'), { recursive: true });
  const filename = path.join(source, 'local-data/library/learning.sqlite');
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE profiles(id TEXT PRIMARY KEY, revision INTEGER); CREATE TABLE records(key TEXT PRIMARY KEY, payload TEXT); PRAGMA user_version = 2;");
  database.prepare('INSERT INTO profiles VALUES (?, ?)').run('old-profile', 8);
  database.prepare('INSERT INTO records VALUES (?, ?)').run('word:résumé', JSON.stringify({ reviews: 4, date: '2026-10-09T08:00:00+08:00' }));
  await fs.mkdir(path.join(source, 'data/magazines/documents'), { recursive: true });
  await fs.writeFile(path.join(source, 'data/magazines/documents/retained.pdf'), '%PDF-retained-attachment');
  try { await run({ root, source, target, filename, database }); }
  finally { database.close(); await fs.rm(root, { recursive: true, force: true }); }
}

test('migration snapshots WAL records, verifies a separate backup, and leaves the source intact', async () => fixture(async ({ source, target, filename }) => {
  const before = inspectLearningDatabase(filename);
  const result = await prepareDesktopData({ userData: target, legacyRoot: source });
  assert.equal(result.migrated, true);
  assert.deepEqual(inspectLearningDatabase(path.join(result.workspace, 'local-data/library/learning.sqlite')), before);
  assert.deepEqual(inspectLearningDatabase(filename), before);
  assert.deepEqual(result.receipt.database, before);
  assert.ok(result.receipt.files.every(file => /^[a-f\d]{64}$/.test(file.sha256)));
  assert.ok(!result.receipt.files.some(file => /-wal$|-shm$/.test(file.path)));
  assert.equal(await fs.readFile(path.join(result.receipt.backup, 'workspace/data/magazines/documents/retained.pdf'), 'utf8'), '%PDF-retained-attachment');
  const reopened = await prepareDesktopData({ userData: target, legacyRoot: source });
  assert.equal(reopened.migrated, false);
  assert.equal(reopened.workspace, result.workspace);
}));

test('an existing unverified destination is preserved and never overwritten', async () => fixture(async ({ source, target }) => {
  const existing = path.join(target, 'workspace/important.txt');
  await fs.mkdir(path.dirname(existing), { recursive: true });
  await fs.writeFile(existing, 'keep me');
  await assert.rejects(prepareDesktopData({ userData: target, legacyRoot: source }), /未核对/);
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep me');
}));

test('a changing source database rejects migration while keeping the original and backup attempt', async () => fixture(async ({ source, target, database }) => {
  await assert.rejects(prepareDesktopData({ userData: target, legacyRoot: source, onProgress: progress => {
    if (progress.path === 'local-data/library/learning.sqlite') database.prepare('UPDATE profiles SET revision = revision + 1').run();
    if (progress.phase === 'backup' && progress.path.startsWith('local-data/')) writeFileSync(path.join(source, 'data/magazines/documents/retained.pdf'), 'changed during backup');
  } }), /发生变化/);
  assert.equal(database.prepare('SELECT revision FROM profiles').get().revision, 9);
  await assert.rejects(fs.access(path.join(target, 'workspace')));
  assert.ok((await fs.readdir(path.join(target, 'migration-backups'))).length > 0);
}));

test('a migrated database disappearing stops startup instead of creating an empty profile', async () => fixture(async ({ source, target }) => {
  const result = await prepareDesktopData({ userData: target, legacyRoot: source });
  await fs.rename(path.join(result.workspace, 'local-data/library/learning.sqlite'), path.join(result.workspace, 'local-data/library/saved-original.sqlite'));
  await assert.rejects(prepareDesktopData({ userData: target }), /缺失/);
}));

test('learning changes during final copying also reject the stale snapshot', async () => fixture(async ({ source, target, database }) => {
  let changed = false;
  await assert.rejects(prepareDesktopData({ userData: target, legacyRoot: source, onProgress: progress => {
    if (progress.phase === 'restore' && !changed) {
      changed = true;
      database.prepare('UPDATE records SET payload = ? WHERE key = ?').run('{"reviews":5}', 'word:résumé');
    }
  } }), /复制期间学习档案发生变化/);
  assert.equal(database.prepare('SELECT payload FROM records').get().payload, '{"reviews":5}');
  await assert.rejects(fs.access(path.join(target, 'workspace')));
}));

test('a deliberate fresh workspace is recorded without inspecting or changing old files', async () => fixture(async ({ target, filename }) => {
  const before = inspectLearningDatabase(filename);
  const result = await prepareDesktopData({ userData: target });
  assert.equal(result.receipt.source, null);
  assert.equal(result.migrated, false);
  assert.deepEqual(inspectLearningDatabase(filename), before);
}));

test('migration keeps personal imports, original attachments, recovery backups and user dictionaries, excluding installed resources', async () => fixture(async ({ source, target }) => {
  const personal = {
    'local-data/library/backups/recovery.sqlite': 'existing recovery snapshot',
    'local-data/dictionary/settings.json': '{"dictionary":"personal"}',
    'local-data/dictionary/imports/mdx-example/dictionary.mdx': 'personal MDX',
    'local-data/imports/retained.txt': 'legacy personal import',
    'local-data/backfill-results.json': '{"articles":[]}',
    'data/magazines/document_images/retained.png': 'personal picture',
    'data/magazines/document_pages/retained/1.png': 'retained source page',
    'data/magazines/blobs/retained.epub': 'original publication',
    'data/dictionary/imported/personal.sqlite': 'personal dictionary',
    'data/dictionary/readage/entries.json': 'saved dictionary entries',
    'data/dictionary/revisions/personal.json': 'dictionary revisions',
  };
  const installed = {
    'local-data/android-speech/model.onnx': 'Android speech model',
    'local-data/android-translation/model.gguf': 'Android translation model',
    'local-data/kokoro-models/onnx/model.onnx': 'Windows speech model',
    'local-data/kokoro-french/ff_siwis.bin': 'installed French voice',
    'local-data/kokoro-japanese/python/python.exe': 'installed Python',
    'local-data/kokoro-runtime/node_modules/package/index.js': 'installed package',
    'local-data/translation/model.gguf': 'Windows translation model',
    'local-data/startup-logs/desktop.log': 'temporary log',
    'local-data/ui-previews/preview.png': 'preview picture',
    'local-data/backfill-progress.json': 'temporary import progress',
  };
  for (const [relative, content] of Object.entries({ ...personal, ...installed })) {
    await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await fs.writeFile(path.join(source, relative), content);
  }
  const planned = await inspectDesktopMigrationSource(source);
  assert.equal(planned.files, Object.keys(personal).length + 2); // Main DB and the fixture PDF, without WAL/SHM.
  assert.equal(planned.bytes, planned.sources.reduce((bytes, row) => bytes + row.bytes, 0));
  assert.deepEqual(Object.keys(planned).sort(), ['bytes', 'files', 'sources']);
  assert.ok(planned.sources.every(row => Object.keys(row).sort().join() === 'bytes,files,path'));
  const result = await prepareDesktopData({ userData: target, legacyRoot: source, onProgress: progress => {
    if (progress.phase === 'restore') writeFileSync(path.join(source, 'local-data/startup-logs/desktop.log'), `log still growing ${progress.completed}`);
  } });
  assert.equal(result.receipt.files.length, planned.files);
  for (const [relative, content] of Object.entries(personal)) {
    assert.equal(await fs.readFile(path.join(result.workspace, relative), 'utf8'), content);
    assert.equal(await fs.readFile(path.join(result.receipt.backup, 'workspace', relative), 'utf8'), content);
    assert.ok(result.receipt.files.some(file => file.path === relative));
  }
  for (const relative of Object.keys(installed)) {
    await assert.rejects(fs.access(path.join(result.workspace, relative)));
    await assert.rejects(fs.access(path.join(result.receipt.backup, 'workspace', relative)));
    assert.ok(!result.receipt.files.some(file => file.path === relative));
    assert.ok(await fs.stat(path.join(source, relative)));
  }
}));

test('models alone are not mistaken for a personal archive', async () => fixture(async ({ source, target }) => {
  const resourcesOnly = path.join(source, 'resources-only');
  const model = path.join(resourcesOnly, 'local-data/translation/model.gguf');
  await fs.mkdir(path.dirname(model), { recursive: true });
  await fs.writeFile(model, 'installed model');
  assert.equal(await hasLegacyDesktopData(resourcesOnly), false);
  assert.deepEqual(await inspectDesktopMigrationSource(resourcesOnly), { files: 0, bytes: 0, sources: [] });
  await assert.rejects(prepareDesktopData({ userData: target, legacyRoot: resourcesOnly }), /没有 local-data 或本地文章/);
  await assert.rejects(fs.access(path.join(target, 'workspace')));
  assert.equal(await fs.readFile(model, 'utf8'), 'installed model');
}));

test('personal imports are detected even without a learning database or magazine catalogue', async () => fixture(async ({ source }) => {
  const importsOnly = path.join(source, 'imports-only');
  const file = path.join(importsOnly, 'local-data/imports/retained.txt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'personal import');
  assert.equal(await hasLegacyDesktopData(importsOnly), true);
  assert.deepEqual(await inspectDesktopMigrationSource(importsOnly), {
    files: 1, bytes: 15, sources: [{ path: 'local-data/imports', files: 1, bytes: 15 }],
  });
}));

test('a linked ancestor cannot make an allowed personal directory escape its selected source', async () => fixture(async ({ root, source, target }) => {
  const linkedSource = path.join(root, 'linked-source');
  await fs.mkdir(linkedSource);
  await fs.symlink(path.join(source, 'local-data'), path.join(linkedSource, 'local-data'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectDesktopMigrationSource(linkedSource), /链接/);
  await assert.rejects(prepareDesktopData({ userData: target, legacyRoot: linkedSource }), /链接/);
  await assert.rejects(fs.access(path.join(target, 'workspace')));
}));
