import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { createDictionaryRouter } from '../server/dictionary/routes';
import { createDictionarySettingsRouter } from '../server/dictionary/settingsRoutes';
import { createExactLanguageAdapter, createInMemoryDictionary } from '../packages/dictionary/examples/inMemory';

function workspace(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readage-dictionary-settings-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-dictionary-settings-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, settingsFile: path.join(directory, 'dictionary', 'settings.json') };
}

test('saving source preferences applies to the same service immediately and survives restart without changing identities', async t => {
  const { settingsFile } = workspace(t);
  const runtime = createDictionaryRuntime({ settingsFile });
  const service = runtime.service;
  const adapters = [runtime.ecdict, runtime.native];
  const identity = await runtime.resolveLearningTerms(['running']);
  const before = service.listSources().catalogVersion;
  const next = await runtime.settings.update({ expectedRevision: runtime.settings.snapshot().settings.revision,
    enabledSources: ['ecdict'], sourceOrder: ['ecdict', 'native-reviewed'], defaultSource: 'ecdict' });
  assert.equal(runtime.service, service, 'mounted routes retain the live service proxy');
  assert.deepEqual([runtime.ecdict, runtime.native], adapters, 'installed adapters are reused');
  assert.notEqual(service.listSources().catalogVersion, before);
  assert.deepEqual((await service.lookup({ text: 'running', language: 'en' })).sources.map(source => source.dictionaryId), ['ecdict']);
  assert.deepEqual(await runtime.resolveLearningTerms(['running']), identity);
  assert.equal(identity[0].stableId, 'run');
  assert.equal((await service.lookup({ text: 'bank', language: 'en', dictionaryIds: ['native-reviewed'] })).status, 'invalid_request');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), next);
  assert.deepEqual(fs.readdirSync(path.dirname(settingsFile)), ['settings.json'], 'atomic temporary files are cleaned');
  const restarted = createDictionaryRuntime({ settingsFile, sourceOrder: ['native-reviewed', 'ecdict'], defaultSource: 'native-reviewed' });
  assert.deepEqual(restarted.settings.snapshot().settings, next);
  assert.equal(restarted.service.listSources().defaultSource, 'ecdict');
  assert.deepEqual(await restarted.resolveLearningTerms(['running']), identity);
  const staleStartup = createDictionaryRuntime({ settingsFile, enabledSources: ['removed-pack'],
    sourceOrder: ['removed-pack'], defaultSource: 'removed-pack' });
  assert.deepEqual(staleStartup.settings.snapshot().settings, next, 'valid saved preferences override stale startup IDs');
  await runtime.settings.update({ expectedRevision: next.revision,
    enabledSources: ['native-reviewed'], sourceOrder: ['native-reviewed', 'ecdict'], defaultSource: 'native-reviewed' });
  assert.deepEqual((await service.lookup({ text: 'running', language: 'en' })).learningTermRef, identity[0]);
  assert.equal((await runtime.resolveLearningTerms(['books']))[0].stableId, 'book',
    'ECDICT morphology remains usable for a previously unresolved surface when disabled for display');
  assert.deepEqual((await createDictionaryRuntime({ settingsFile }).resolveLearningTerms(['running'])), identity);
});

test('invalid selections never alter running sources or the saved snapshot', async t => {
  const { settingsFile } = workspace(t);
  const runtime = createDictionaryRuntime({ settingsFile });
  const state = runtime.settings.snapshot().settings;
  for (const patch of [
    { enabledSources: [] }, { enabledSources: ['unknown'] }, { enabledSources: ['ecdict', 'ecdict'] },
    { enabledSources: ['ecdict'], defaultSource: 'native-reviewed' }, { sourceOrder: ['ecdict'] },
    { sourceOrder: ['ecdict', 'ecdict'] }, { sourceOrder: ['native-reviewed', 'unknown'] },
    { defaultSource: 'unknown' }, { enabledSources: 'ecdict' },
  ]) {
    await assert.rejects(runtime.settings.update({ ...state, expectedRevision: state.revision, ...patch }),
      (error: any) => error.status === 400 && error.code === 'INVALID_SETTINGS');
    assert.deepEqual(runtime.settings.snapshot().settings, state);
    assert.equal(fs.existsSync(settingsFile), false);
  }
  const detached = runtime.settings.snapshot().settings;
  detached.enabledSources.length = 0;
  assert.deepEqual(runtime.settings.snapshot().settings, state, 'callers cannot mutate the active settings through snapshots');
});

test('concurrent saves compare revisions after serialization and reject the stale writer', async t => {
  const { settingsFile } = workspace(t);
  const runtime = createDictionaryRuntime({ settingsFile });
  const expectedRevision = runtime.settings.snapshot().settings.revision;
  const changes = [
    { enabledSources: ['ecdict'], sourceOrder: ['ecdict', 'native-reviewed'], defaultSource: 'ecdict' },
    { enabledSources: ['native-reviewed'], sourceOrder: ['native-reviewed', 'ecdict'], defaultSource: 'native-reviewed' },
  ];
  const results = await Promise.allSettled(changes.map(selection => runtime.settings.update({ expectedRevision, ...selection })));
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  if (results[1].status === 'rejected') assert.equal(results[1].reason.status, 409);
  assert.deepEqual(runtime.settings.snapshot().settings.enabledSources, ['ecdict']);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).enabledSources, ['ecdict']);
});

test('a persistence failure returns unavailable while active configuration and lookup stay unchanged', async t => {
  const { directory, settingsFile } = workspace(t);
  const runtime = createDictionaryRuntime({ settingsFile });
  const initial = runtime.settings.snapshot().settings;
  const before = runtime.service.listSources();
  fs.writeFileSync(path.join(directory, 'dictionary'), 'a file prevents directory creation');
  await assert.rejects(runtime.settings.update({ expectedRevision: initial.revision,
    enabledSources: ['ecdict'], sourceOrder: ['ecdict', 'native-reviewed'], defaultSource: 'ecdict' }),
  (error: any) => error.status === 503 && error.code === 'SETTINGS_STORAGE_UNAVAILABLE');
  assert.deepEqual(runtime.settings.snapshot().settings, initial);
  assert.deepEqual(runtime.service.listSources(), before);
  assert.equal((await runtime.service.lookup({ text: 'bank', language: 'en' })).status, 'found');
  assert.equal(fs.readFileSync(path.join(directory, 'dictionary'), 'utf8'), 'a file prevents directory creation');
});

test('an unreadable saved snapshot is reported and remains untouched until an explicit reviewed save', async t => {
  const { settingsFile } = workspace(t);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, '{malformed preferences');
  const runtime = createDictionaryRuntime({ settingsFile });
  const snapshot = runtime.settings.snapshot();
  assert.match(snapshot.warning!, /could not be read/);
  assert.match(snapshot.settings.revision, /^unreadable:/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{malformed preferences');
  await runtime.settings.update({ ...snapshot.settings, expectedRevision: snapshot.settings.revision });
  assert.equal(runtime.settings.snapshot().warning, undefined);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).version, 'dictionary-settings.v1');
});

test('restarting reconciles changed installations and registration survives later settings updates', async t => {
  const { settingsFile } = workspace(t);
  const extra = createInMemoryDictionary({ id: 'french-pack', language: 'fr', contentVersion: '1',
    entries: [{ id: 'été', headword: 'été', definitions: [{ language: 'zh', text: '夏天' }] }] });
  const first = createDictionaryRuntime({ settingsFile, additionalDictionaries: [extra] });
  await first.settings.update({ expectedRevision: first.settings.snapshot().settings.revision,
    enabledSources: ['french-pack'], sourceOrder: ['french-pack', 'native-reviewed', 'ecdict'], defaultSource: 'french-pack' });
  const changed = createDictionaryRuntime({ settingsFile });
  assert.match(changed.settings.snapshot().warning!, /Installed dictionaries changed/);
  assert.deepEqual(changed.settings.snapshot().settings.enabledSources, ['native-reviewed']);
  changed.service.registerLanguage(createExactLanguageAdapter('fr'));
  changed.service.registerDictionary(extra);
  assert.equal(changed.service.listSources().sources.find(source => source.id === 'french-pack')?.enabled, false,
    'newly registered dictionaries do not override a saved explicit selection');
  await changed.settings.update({ expectedRevision: changed.settings.snapshot().settings.revision,
    enabledSources: ['french-pack'], sourceOrder: ['french-pack', 'ecdict', 'native-reviewed'], defaultSource: 'french-pack' });
  assert.equal((await changed.service.lookup({ text: 'été', language: 'fr' })).status, 'found');
  assert.equal((await changed.service.getEntry({ dictionaryId: 'french-pack', entryId: 'été' })).entry?.headword, 'été');
});

test('settings HTTP gives conflict/invalid statuses, rejects cross-origin writes and keeps pre-mounted lookup routes live', async t => {
  const { settingsFile } = workspace(t);
  const runtime = createDictionaryRuntime({ settingsFile });
  const app = express();
  app.use(express.json());
  app.use('/api/dictionary/v1', createDictionarySettingsRouter(runtime.settings, runtime.service));
  app.use('/api/dictionary/v1', createDictionaryRouter(runtime.service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/api/dictionary/v1/settings`;
  const initial = await (await fetch(url)).json();
  assert.equal(initial.ok, true);
  assert.equal(initial.settings.version, 'dictionary-settings.v1');
  const body = { expectedRevision: initial.settings.revision, enabledSources: ['ecdict'],
    sourceOrder: ['ecdict', 'native-reviewed'], defaultSource: 'ecdict' };
  const put = (payload = body, extra: Record<string, string> = {}) => fetch(url, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...extra }, body: JSON.stringify(payload) });
  assert.equal((await put(body, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await put(body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await put({ ...body, enabledSources: [] })).status, 400);
  const saved = await put();
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).catalog.defaultSource, 'ecdict');
  assert.equal((await put()).status, 409);
  const sources = await (await fetch(`${origin}/api/dictionary/v1/sources`)).json();
  assert.equal(sources.catalog.defaultSource, 'ecdict');
  const lookup = await (await fetch(`${origin}/api/dictionary/v1/lookup`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'bank', language: 'en' }) })).json();
  assert.deepEqual(lookup.result.sources.map((source: any) => source.dictionaryId), ['ecdict']);
});

test('an explicitly configured missing WordNet pack stays installed with an unavailable capability state', t => {
  const { directory } = workspace(t);
  const runtime = createDictionaryRuntime({ wordnetDir: path.join(directory, 'missing') });
  const source = runtime.service.listSources().sources.find(source => source.id === 'wordnet');
  assert.ok(source);
  assert.equal(source.available, false);
  assert.equal(source.enabled, true);
  assert.deepEqual(runtime.settings.snapshot().settings.sourceOrder, ['native-reviewed', 'ecdict', 'wordnet']);
});
