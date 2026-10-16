import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SourceCatalog } from '../packages/dictionary/contracts';
import {
  createDictionarySettingsClient,
  DictionarySettingsError,
  dictionarySettingsEqual,
  moveDictionarySource,
  reorderDictionarySource,
  setDictionarySourceOrder,
  retainDictionaryDraftAfterImport,
  setDictionaryEnabled,
  MAX_DICTIONARY_IMPORT_BYTES,
  validateDictionaryImportFile,
  type DictionarySettings,
  type DictionarySettingsSnapshot,
} from '../src/lib/dictionarySettingsClient';

const settings: DictionarySettings = { version: 'dictionary-settings.v1', revision: 'revision-one',
  enabledSources: ['native-reviewed', 'ecdict', 'wordnet'],
  sourceOrder: ['native-reviewed', 'ecdict', 'wordnet'], defaultSource: 'native-reviewed' };
const catalog: SourceCatalog = { protocolVersion: 'dictionary-api.v1', catalogVersion: 'catalog-one', defaultSource: settings.defaultSource,
  sources: settings.sourceOrder.map((id, priority) => ({ id, name: id === 'wordnet' ? 'WordNet 3.1' : id, languages: ['en'],
    ...(id === 'native-reviewed' ? { entryCount: 50, description: '仅包含已审核词条，未收录的词不会显示本词典释义。' } : {}),
    definitionLanguages: id === 'wordnet' ? ['en'] : ['en', 'zh'], contentVersion: `${id}:3.1:${'a'.repeat(64)}`,
    schemaVersion: 'dictionary-entry.v1', adapterVersion: `${id}-adapter.v1`,
    capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' },
    provenance: [{ kind: 'publisher', label: id === 'wordnet' ? 'Princeton WordNet' : 'local' }],
    enabled: true, priority, available: id !== 'wordnet' })) };
const snapshot: DictionarySettingsSnapshot = { settings, catalog };

// Keep the real screen and its browser imports together, while CSS is handled by Vite in the application.
const temporaryDirectory = fs.mkdtempSync(path.resolve('tmp/dictionary-settings-ui-'));
const bundleFile = path.join(temporaryDirectory, 'screen.mjs');
const bundle = buildSync({ entryPoints: ['src/components/DictionarySettingsScreen.tsx'], absWorkingDir: process.cwd(),
  platform: 'node', format: 'esm', bundle: true, write: false, packages: 'external', loader: { '.css': 'empty' },
  target: 'es2022', external: ['react', 'react-dom'] });
fs.writeFileSync(bundleFile, bundle.outputFiles[0].text);
const { DictionarySettingsScreen, compactDictionaryVersion } = await import(pathToFileURL(bundleFile).href);
test.after(() => { fs.unlinkSync(bundleFile); fs.rmdirSync(temporaryDirectory); });

test('dictionary settings shows compact draggable cards and keeps optional settings collapsed', () => {
  const html = renderToStaticMarkup(React.createElement(DictionarySettingsScreen, { onBack() {}, initialSnapshot: snapshot }));
  assert.ok(html.indexOf('ReadAge 自编词典') < html.indexOf('ECDICT 内置词典'));
  assert.ok(html.indexOf('ECDICT 内置词典') < html.indexOf('WordNet 3.1'));
  assert.match(html, /aria-label="启用 ReadAge 自编词典"/);
  assert.match(html, /aria-label="调整 WordNet 3.1 的顺序"/);
  assert.match(html, /data-dictionary-id="wordnet"/);
  assert.doesNotMatch(html, /draggable="true"/);
  assert.match(html, /id="dictionary-drag-help"/);
  assert.doesNotMatch(html, /aria-label="(?:上移|下移) /);
  assert.doesNotMatch(html, />顺序 [123]</);
  assert.match(html, /aria-label="将 WordNet 3.1 设为默认词典"/);
  assert.match(html, /暂不可用/);
  assert.match(html, /其他已启用词典仍可用于查词/);
  assert.match(html, /<dt>释义语言<\/dt><dd>英语/);
  assert.match(html, /<details[^>]*class="dictionary-settings__metadata"/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|>)/);
  assert.doesNotMatch(html, /保存设置|还原更改|有未保存的更改|dictionary-settings__save-bar/);
  assert.match(html, /type="file" accept="\.mdx,\.nwdict,\.pack,\.zip"/);
  assert.match(html, /aria-label="导入词典文件"/);
  assert.match(html, /导入词典<\/button>/);
  const collapsedContent = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  assert.match(collapsedContent, /已收录 50 个词条/);
  assert.match(collapsedContent, /仅包含已审核词条/);
  assert.match(collapsedContent, /默认词典优先展示/);
  assert.doesNotMatch(collapsedContent, /词条语言|释义语言|数据结构|适配器/);
});

test('corrupt persisted preferences offer a repair action without a routine save footer', () => {
  const html = renderToStaticMarkup(React.createElement(DictionarySettingsScreen, {
    onBack() {}, initialSnapshot: { ...snapshot, warning: '已保存的词典设置无法读取，正在使用默认设置。' },
  }));
  assert.match(html, /role="alert"[^>]*><span>已保存的词典设置无法读取/);
  const saveButton = html.match(/<button[^>]*>修复设置<\/button>/)?.[0];
  assert.ok(saveButton);
  assert.doesNotMatch(saveButton, /disabled/);
  assert.doesNotMatch(html, /保存设置|还原更改|有未保存的更改/);
  assert.equal(compactDictionaryVersion(`wordnet:3.1:${'a'.repeat(64)}`), 'wordnet:3.1:aaaaaaaa');
});

test('draft toggles and ordering retain all sources, require one enabled, and choose an enabled default', () => {
  const disabled = setDictionaryEnabled(settings, 'native-reviewed', false);
  assert.deepEqual(disabled.enabledSources, ['ecdict', 'wordnet']);
  assert.equal(disabled.defaultSource, 'ecdict');
  assert.deepEqual(disabled.sourceOrder, settings.sourceOrder);
  assert.equal(settings.defaultSource, 'native-reviewed', 'edits never mutate the loaded snapshot');
  const moved = moveDictionarySource(disabled, 'wordnet', -1);
  assert.deepEqual(moved.sourceOrder, ['native-reviewed', 'wordnet', 'ecdict']);
  assert.deepEqual(moved.enabledSources, ['wordnet', 'ecdict']);
  assert.equal(moved.defaultSource, 'ecdict', 'reordering does not silently switch the default');
  assert.equal(dictionarySettingsEqual(settings, settings), true);
  assert.equal(dictionarySettingsEqual(settings, moved), false);
  const last = setDictionaryEnabled(disabled, 'wordnet', false);
  assert.equal(setDictionaryEnabled(last, 'ecdict', false), last);
  assert.equal(moveDictionarySource(settings, 'native-reviewed', -1), settings);
  assert.equal(moveDictionarySource(settings, 'unknown', 1), settings);
});

test('dragging before and after a target correctly reorders in both directions without changing the default', () => {
  const down = reorderDictionarySource(settings, 'native-reviewed', 'wordnet', 'after');
  assert.deepEqual(down.sourceOrder, ['ecdict', 'wordnet', 'native-reviewed']);
  assert.deepEqual(down.enabledSources, down.sourceOrder);
  assert.equal(down.defaultSource, 'native-reviewed');
  const up = reorderDictionarySource(settings, 'wordnet', 'native-reviewed', 'before');
  assert.deepEqual(up.sourceOrder, ['wordnet', 'native-reviewed', 'ecdict']);
  assert.equal(reorderDictionarySource(settings, 'native-reviewed', 'ecdict', 'before'), settings);
  assert.equal(reorderDictionarySource(settings, 'ecdict', 'ecdict', 'after'), settings);
  assert.equal(reorderDictionarySource(settings, 'unknown', 'ecdict', 'before'), settings);
});

test('live drag ordering requires a complete permutation and retains disabled sources and the chosen default', () => {
  const before = setDictionaryEnabled(settings, 'ecdict', false);
  const order = ['wordnet', 'ecdict', 'native-reviewed'];
  const after = setDictionarySourceOrder(before, order);
  assert.deepEqual(after.sourceOrder, order);
  assert.deepEqual(after.enabledSources, ['wordnet', 'native-reviewed']);
  assert.equal(after.defaultSource, before.defaultSource);
  assert.deepEqual(before.sourceOrder, settings.sourceOrder, 'the pre-drag snapshot remains usable when a gesture is cancelled');
  order.reverse();
  assert.deepEqual(after.sourceOrder, ['wordnet', 'ecdict', 'native-reviewed'], 'the callback array is not retained by reference');
  for (const invalid of [['wordnet'], ['wordnet', 'wordnet', 'native-reviewed'], ['wordnet', 'unknown', 'native-reviewed']]) {
    assert.equal(setDictionarySourceOrder(before, invalid), before, 'partial or stale layout updates cannot change installed sources');
  }
  assert.equal(setDictionarySourceOrder(before, [...before.sourceOrder]), before);
});

test('a confirmed import adds the enabled source and new revision while preserving unsaved local order and toggles', () => {
  const imported: DictionarySettings = { ...settings, revision: 'revision-imported',
    sourceOrder: [...settings.sourceOrder, 'mdx-test'], enabledSources: [...settings.enabledSources, 'mdx-test'] };
  const local = reorderDictionarySource(setDictionaryEnabled(settings, 'native-reviewed', false), 'wordnet', 'ecdict', 'before');
  const retained = retainDictionaryDraftAfterImport(local, settings, imported);
  assert.deepEqual(retained.sourceOrder, ['native-reviewed', 'wordnet', 'ecdict', 'mdx-test']);
  assert.deepEqual(retained.enabledSources, ['wordnet', 'ecdict', 'mdx-test']);
  assert.equal(retained.defaultSource, 'ecdict');
  assert.equal(retained.revision, 'revision-imported');
  assert.equal(retainDictionaryDraftAfterImport(settings, settings, imported), imported);
});

test('the settings client sends authenticated explicit PUTs with revision and abort support', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __ENGLISH_AI_API_TOKEN__: 'settings-test-token' } });
  try {
    const client = createDictionarySettingsClient({ fetcher: (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ ok: true, ...snapshot }));
    }) as typeof fetch });
    const signal = new AbortController().signal;
    assert.deepEqual(await client.load(signal), snapshot);
    const next = moveDictionarySource(settings, 'wordnet', -1);
    await client.save({ expectedRevision: settings.revision, enabledSources: next.enabledSources,
      sourceOrder: next.sourceOrder, defaultSource: next.defaultSource }, signal);
    assert.equal(requests[0].url, '/api/dictionary/v1/settings');
    assert.equal(requests[0].init.method, 'GET');
    assert.equal(requests[1].init.method, 'PUT');
    assert.equal(requests[1].init.signal, signal);
    assert.equal(requests[1].init.keepalive, true, 'a small preference write can finish when the page is left');
    assert.equal(requests[1].init.credentials, 'same-origin');
    assert.equal((requests[1].init.headers as Record<string, string>).Authorization, 'Bearer settings-test-token');
    assert.deepEqual(JSON.parse(requests[1].init.body as string).sourceOrder, next.sourceOrder);
    assert.equal(JSON.parse(requests[1].init.body as string).expectedRevision, 'revision-one');
    const canceled = new AbortController(); canceled.abort();
    await assert.rejects(client.load(canceled.signal), { name: 'AbortError' });
    assert.equal(requests.length, 2);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('the settings client preserves conflict status and rejects incompatible responses', async () => {
  const conflict = createDictionarySettingsClient({ fetcher: (async () => new Response(JSON.stringify({ error: { code: 'SETTINGS_CONFLICT' } }), { status: 409 })) as typeof fetch });
  await assert.rejects(conflict.save({ expectedRevision: settings.revision, enabledSources: settings.enabledSources,
    sourceOrder: settings.sourceOrder, defaultSource: settings.defaultSource }), error => error instanceof DictionarySettingsError && error.status === 409);
  const incompatible = createDictionarySettingsClient({ fetcher: (async () => new Response(JSON.stringify({ ok: true, ...snapshot,
    settings: { ...settings, version: 'dictionary-settings.v2' } }))) as typeof fetch });
  await assert.rejects(incompatible.load(), error => error instanceof DictionarySettingsError && error.code === 'INVALID_RESPONSE');
});

test('MDX import uploads the real File bytes with metadata headers and applies the confirmed source envelope', async () => {
  const file = new File([new Uint8Array([0, 1, 2, 3])], '私人词典.mdx', { type: 'application/octet-stream' });
  const imported = { ...snapshot, imported: { dictionaryId: 'mdx-test', name: '私人词典', entryCount: 3 } };
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createDictionarySettingsClient({ fetcher: (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ ok: true, ...imported }));
  }) as typeof fetch });
  const signal = new AbortController().signal;
  assert.deepEqual(await client.importFile(file, { language: 'ja', name: '私人词典', signal }), imported);
  assert.equal(requests[0].url, '/api/dictionary/v1/import');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.body, file, 'the upload must not serialize or base64 encode the dictionary');
  assert.equal(requests[0].init.signal, signal);
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/octet-stream');
  assert.equal(headers['X-Import-Filename'], encodeURIComponent(file.name));
  assert.equal(headers['X-Dictionary-Language'], 'ja');
  assert.equal(headers['X-Dictionary-Name'], encodeURIComponent('私人词典'));
  assert.equal(requests[0].init.credentials, 'same-origin');
  await client.importFile(file);
  assert.equal((requests[1].init.headers as Record<string, string>)['X-Dictionary-Language'], 'en');
});

test('a durable MDX import notice remains separate from settings repair and has no manual save controls', async () => {
  const importedSettings: DictionarySettings = { ...settings, revision: 'revision-imported',
    sourceOrder: [...settings.sourceOrder, 'mdx-test'], enabledSources: [...settings.enabledSources, 'mdx-test'] };
  const importedCatalog: SourceCatalog = { ...catalog, catalogVersion: 'catalog-imported',
    sources: [...catalog.sources, { ...catalog.sources[0], id: 'mdx-test', name: '我的 MDX', priority: catalog.sources.length }] };
  const warning = 'MDX 已导入；独立 MDD 资源、外部样式和脚本暂不加载。';
  const client = createDictionarySettingsClient({ fetcher: (async () => new Response(JSON.stringify({ ok: true,
    settings: importedSettings, catalog: importedCatalog, warning,
    imported: { dictionaryId: 'mdx-test', name: '我的 MDX', entryCount: 3 } }))) as typeof fetch });
  const imported = await client.importFile(new File(['data'], 'test.mdx'));
  assert.equal(imported.importWarning, warning, 'compatibility information remains available to the success notice');
  assert.equal('warning' in imported, false, 'an import notice cannot masquerade as a settings-repair warning');
  assert.equal(dictionarySettingsEqual(retainDictionaryDraftAfterImport(settings, settings, imported.settings), imported.settings), true);
  const html = renderToStaticMarkup(React.createElement(DictionarySettingsScreen, { onBack() {}, initialSnapshot: imported }));
  assert.doesNotMatch(html, /保存设置|修复设置/);
  assert.doesNotMatch(html, /有未保存的更改/);
  assert.doesNotMatch(html, /还原更改/);
  const edited = retainDictionaryDraftAfterImport(moveDictionarySource(settings, 'wordnet', -1), settings, imported.settings);
  assert.equal(dictionarySettingsEqual(edited, imported.settings), false, 'a real pre-import draft still needs saving');
});

test('MDX validation rejects wrong formats, empty or oversized files and invalid languages before upload', async () => {
  assert.throws(() => validateDictionaryImportFile({ name: 'dictionary.json', size: 10 }), /MDX/);
  assert.throws(() => validateDictionaryImportFile({ name: 'dictionary.mdx', size: 0 }), /为空/);
  assert.throws(() => validateDictionaryImportFile({ name: 'dictionary.mdx', size: MAX_DICTIONARY_IMPORT_BYTES + 1 }), /256 MB/);
  let requests = 0;
  const client = createDictionarySettingsClient({ fetcher: (async () => { requests++; throw new Error('should not upload'); }) as typeof fetch });
  const file = new File(['data'], 'test.mdx');
  await assert.rejects(client.importFile(file, { language: 'en_invalid' }), /语言无效/);
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(client.importFile(file, { signal: canceled.signal }), { name: 'AbortError' });
  assert.equal(requests, 0);
});

test('an aborted MDX response and parser rejection remain errors instead of reporting successful import', async () => {
  const file = new File(['data'], 'test.mdx');
  const rejected = createDictionarySettingsClient({ fetcher: (async () => new Response(JSON.stringify({ ok: false,
    error: { code: 'UNSUPPORTED_MDX', message: '此 MDX 文件的压缩方式暂不支持。' } }), { status: 400 })) as typeof fetch });
  await assert.rejects(rejected.importFile(file), /压缩方式暂不支持/);
  const controller = new AbortController();
  const aborted = createDictionarySettingsClient({ fetcher: (async () => {
    controller.abort();
    return new Response(JSON.stringify({ ok: true, ...snapshot, imported: { dictionaryId: 'mdx-test', name: 'test', entryCount: 1 } }));
  }) as typeof fetch });
  await assert.rejects(aborted.importFile(file, { signal: controller.signal }), { name: 'AbortError' });
});
