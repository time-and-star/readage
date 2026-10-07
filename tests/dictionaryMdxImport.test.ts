import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { makeMdxFixture } from './helpers/mdxFixture';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { createDictionaryImportRouter } from '../server/dictionary/importRoutes';
import { discoverImportedDictionaries } from '../server/dictionary/imports';
import { MdxDictionaryAdapter, preflightMdx, mdxHash, mdxAdler32, MDX_PLAIN_TEXT_EXTENSION, type ImportedMdxManifest } from '../packages/dictionary/server/mdxAdapter';
import { createDictionaryService } from '../packages/dictionary/core';
import { englishLanguageAdapter } from '../packages/dictionary/languages/english';

function workspace(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readage-mdx-import-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-mdx-import-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, importsDir: path.join(directory, 'imports'), settingsFile: path.join(directory, 'settings', 'settings.json') };
}
function adapter(t: TestContext, directory: string, bytes: Buffer, language = 'ja') {
  const file = path.join(directory, `fixture-${mdxHash(bytes)}.mdx`);
  fs.writeFileSync(file, bytes);
  const manifest: ImportedMdxManifest = { format: 'dictionary-mdx-import.v1', dictionaryId: `mdx-${mdxHash(bytes)}`,
    name: 'Test MDX', language, sha256: mdxHash(bytes), bytes: bytes.length, entryCount: preflightMdx(bytes).entryCount, filename: 'fixture.mdx' };
  const value = new MdxDictionaryAdapter({ file, manifest });
  t.after(() => value.dispose());
  return value;
}

test('real MDX v1/v2, UTF8/UTF16, encrypted key info and records crossing blocks preserve Unicode original entries', async t => {
  const { directory } = workspace(t);
  for (const options of [{}, { version: 1.2 as const, compressed: false },
    { encoding: 'UTF-16' as const, encryptedKeyInfo: true, recordBlockBytes: 30 }]) {
    const source = adapter(t, directory, makeMdxFixture(options));
    const service = createDictionaryService(); service.registerDictionary(source);
    const result = await service.lookup({ text: '𠮷', language: 'ja' });
    assert.equal(result.status, 'found');
    assert.equal(result.languageCapabilities.normalization, 'unsupported');
    const entry = result.sources[0].matches[0].entry;
    assert.equal(entry.language, 'ja');
    assert.equal(entry.content.kind, 'original');
    if (entry.content.kind === 'original') assert.match(entry.content.content, /日本語の例/);
    assert.equal((entry.extensions?.[MDX_PLAIN_TEXT_EXTENSION] as any).language, 'ja');
    assert.equal((await service.getEntry({ dictionaryId: source.metadata.id, entryId: entry.entryId })).entry?.headword, '𠮷');
    const alias = await service.lookup({ text: 'banks', language: 'ja' });
    assert.match((alias.sources[0].matches[0].entry.extensions?.[MDX_PLAIN_TEXT_EXTENSION] as any).text, /A place that holds money/);
    assert.equal(alias.sources[0].matches[0].entry.headword, 'banks');
  }
});

test('without a language adapter MDX never lowercases or strips Unicode input; declared case folding is available with an adapter', async t => {
  const { directory } = workspace(t);
  const bytes = makeMdxFixture({ entries: [{ key: 'Mixed', html: '<p>A mixed term.</p>' }, { key: 'かな𠮷', html: '<p>日本語の定義。</p>' }] });
  const source = adapter(t, directory, bytes, 'en');
  const service = createDictionaryService(); service.registerDictionary(source);
  assert.equal((await service.lookup({ text: 'mixed', language: 'en' })).status, 'not_found');
  assert.equal((await service.lookup({ text: 'Mixed', language: 'en' })).status, 'found');
  service.registerLanguage(englishLanguageAdapter);
  assert.equal((await service.lookup({ text: 'mixed', language: 'en' })).status, 'found');
  assert.equal((await service.lookup({ text: 'かな𠮷', language: 'en' })).status, 'found');
});

test('many small MDX key blocks build one linear index and retain cross-block record boundaries', async t => {
  const { directory } = workspace(t);
  const entries = Array.from({ length: 1000 }, (_, index) => ({ key: `term-${String(index).padStart(4, '0')}`, html: `<p>Definition ${index}.</p>` }));
  const source = adapter(t, directory, makeMdxFixture({ entries, keysPerBlock: 1, recordBlockBytes: 47 }));
  for (const index of [0, 333, 999]) {
    const result = await source.lookup({ text: entries[index].key, language: 'ja', candidates: [{ text: entries[index].key, kind: 'exact' }], exactOnly: true });
    assert.equal(result[0].entry.headword, entries[index].key);
    assert.equal((result[0].entry.extensions?.[MDX_PLAIN_TEXT_EXTENSION] as any).text, `Definition ${index}.`);
  }
});

test('cyclic and dangling MDX links produce explicit source failure rather than a false miss', async t => {
  const { directory } = workspace(t);
  const source = adapter(t, directory, makeMdxFixture({ entries: [
    { key: 'a', html: '@@@LINK=b' }, { key: 'b', html: '@@LINK=a' }, { key: 'dangling', html: '@@@LINK=missing' },
  ] }));
  const service = createDictionaryService(); service.registerDictionary(source);
  assert.equal((await service.lookup({ text: 'a', language: 'ja' })).status, 'unavailable');
  assert.equal((await service.lookup({ text: 'dangling', language: 'ja' })).sources[0].status, 'unavailable');
});

test('plain-text projection excludes active/media containers and keeps ordinary definitions', async t => {
  const { directory } = workspace(t);
  const source = adapter(t, directory, makeMdxFixture({ entries: [{ key: 'safe', html:
    '<p>Visible definition.</p><script>script secret</script><style>style secret</style><iframe>frame secret</iframe><form>form secret</form><svg>svg secret</svg><audio>audio secret</audio><img alt="image secret">' }] }));
  const entry = (await source.lookup({ text: 'safe', language: 'ja', candidates: [{ text: 'safe', kind: 'exact' }], exactOnly: true }))[0].entry;
  const plain = (entry.extensions?.[MDX_PLAIN_TEXT_EXTENSION] as any).text;
  assert.match(plain, /Visible definition/);
  assert.doesNotMatch(plain, /secret/);
});

test('browser-imported MDX becomes enabled after durable persistence, keeps identities and survives a runtime restart', async t => {
  const options = workspace(t);
  const runtime = createDictionaryRuntime(options);
  const service = runtime.service;
  const identity = await runtime.resolveLearningTerms(['running']);
  const before = service.listSources().catalogVersion;
  const imported = await runtime.importDictionary({ bytes: makeMdxFixture(), filename: 'demo.mdx', language: 'en' });
  const id = imported.imported.dictionaryId;
  assert.equal(runtime.service, service);
  assert.equal(imported.imported.entryCount, 5);
  assert.equal(imported.catalog.sources.at(-1)?.id, id);
  assert.equal(imported.catalog.sources.at(-1)?.enabled, true);
  assert.equal(imported.settings.sourceOrder.at(-1), id);
  assert.notEqual(service.listSources().catalogVersion, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.settingsFile, 'utf8')).enabledSources, imported.settings.enabledSources);
  const result = await service.lookup({ text: 'bank', language: 'en', dictionaryIds: [id] });
  assert.equal(result.status, 'found');
  assert.equal(result.sources[0].matches[0].entry.content.kind, 'original');
  assert.deepEqual(await runtime.resolveLearningTerms(['running']), identity);
  const restarted = createDictionaryRuntime(options);
  assert.equal(restarted.service.listSources().sources.find(source => source.id === id)?.enabled, true);
  assert.equal((await restarted.service.lookup({ text: 'bank', language: 'en', dictionaryIds: [id] })).status, 'found');
  assert.deepEqual(await restarted.resolveLearningTerms(['running']), identity);
  assert.deepEqual(fs.readdirSync(options.importsDir), [id]);
});

test('duplicate content imports reuse the stable dictionary ID and preserve an explicit disabled selection', async t => {
  const options = workspace(t);
  const runtime = createDictionaryRuntime(options);
  const input = { bytes: makeMdxFixture(), filename: 'one.mdx' };
  const first = await runtime.importDictionary(input);
  await runtime.settings.update({ expectedRevision: first.settings.revision, enabledSources: ['native-reviewed'],
    sourceOrder: first.settings.sourceOrder, defaultSource: 'native-reviewed' });
  const second = await runtime.importDictionary({ ...input, filename: 'renamed.mdx', name: 'Another name' });
  assert.equal(second.imported.dictionaryId, first.imported.dictionaryId);
  assert.equal(second.imported.name, first.imported.name);
  assert.equal(second.catalog.sources.find(source => source.id === first.imported.dictionaryId)?.enabled, false);
  await assert.rejects(runtime.importDictionary({ ...input, language: 'ja' }),
    (error: any) => error.status === 400 && error.code === 'DICTIONARY_LANGUAGE_MISMATCH');
  assert.deepEqual(fs.readdirSync(options.importsDir), [first.imported.dictionaryId]);
});

test('canonical language tags and bounded filename fallback names remain discoverable after restart', async t => {
  const options = workspace(t);
  const runtime = createDictionaryRuntime(options);
  const result = await runtime.importDictionary({ bytes: makeMdxFixture({ title: '' }),
    filename: `${'a'.repeat(200)}.mdx`, language: 'EN-us' });
  assert.equal(result.imported.name.length, 160);
  assert.deepEqual(result.catalog.sources.at(-1)?.languages, ['en-US']);
  const restarted = createDictionaryRuntime(options);
  assert.equal(restarted.service.listSources().sources.at(-1)?.id, result.imported.dictionaryId);
  await assert.rejects(runtime.importDictionary({ bytes: makeMdxFixture(), filename: 'bad.mdx', language: 'en-u' }),
    (error: any) => error.status === 400 && error.code === 'INVALID_DICTIONARY_LANGUAGE');
});

test('a duplicate upload cannot report success for a missing or corrupt lazily installed file', async t => {
  const options = workspace(t);
  const runtime = createDictionaryRuntime(options);
  const input = { bytes: makeMdxFixture(), filename: 'demo.mdx' };
  const imported = await runtime.importDictionary(input);
  const file = path.join(options.importsDir, imported.imported.dictionaryId, 'dictionary.mdx');
  const bytes = fs.readFileSync(file);
  fs.unlinkSync(file);
  await assert.rejects(runtime.importDictionary(input),
    (error: any) => error.status === 503 && error.code === 'DICTIONARY_ALREADY_INSTALLED_UNAVAILABLE');
  const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 0xff;
  fs.writeFileSync(file, damaged);
  await assert.rejects(runtime.importDictionary(input),
    (error: any) => error.status === 503 && error.code === 'DICTIONARY_ALREADY_INSTALLED_UNAVAILABLE');
  assert.deepEqual(fs.readFileSync(file), damaged, 'a duplicate never overwrites an existing installation');
});

test('preflight rejects corrupt/checksum/oversized metadata, LZO and protected dictionaries without publishing files', async t => {
  const options = workspace(t);
  const runtime = createDictionaryRuntime(options);
  const initial = runtime.service.listSources();
  const original = makeMdxFixture();
  const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 0xff;
  const huge = Buffer.from(original); const headerEnd = huge.readUInt32BE(0) + 8;
  huge.writeBigUInt64BE(1_000_001n, headerEnd + 8);
  huge.writeUInt32BE(mdxAdler32(huge.subarray(headerEnd, headerEnd + 40)), headerEnd + 40);
  const inflatedLimit = Buffer.from(original);
  inflatedLimit.writeBigUInt64BE(1n, headerEnd + 16);
  inflatedLimit.writeUInt32BE(mdxAdler32(inflatedLimit.subarray(headerEnd, headerEnd + 40)), headerEnd + 40);
  const protectedRecord = Buffer.from(original);
  const protectedHeader = Buffer.from(original.subarray(4, headerEnd - 4).toString('utf16le').replace('Encrypted="No"', 'Encrypted="1 "'), 'utf16le');
  protectedHeader.copy(protectedRecord, 4);
  protectedRecord.writeUInt32LE(mdxAdler32(protectedHeader), headerEnd - 4);
  const lzo = Buffer.from(original);
  const keyInfoOffset = headerEnd + 44;
  lzo.writeUInt32LE(1, keyInfoOffset);
  for (const bytes of [Buffer.from('not MDX'), original.subarray(0, 40), corrupt, huge, inflatedLimit, protectedRecord, lzo]) {
    await assert.rejects(runtime.importDictionary({ bytes, filename: 'bad.mdx' }), (error: any) => error.status === 400 && error.code === 'INVALID_MDX');
    assert.deepEqual(runtime.service.listSources(), initial);
    assert.deepEqual(fs.readdirSync(options.importsDir), []);
  }
  await assert.rejects(runtime.importDictionary({ bytes: original, filename: 'image.mdd' }), (error: any) => error.status === 400);
  await assert.rejects(runtime.importDictionary({ bytes: original, filename: 'good.mdx', language: '../ja' }), (error: any) => error.status === 400);
  assert.equal(fs.existsSync(options.settingsFile), false);
});

test('settings-write failure rolls back registry and imported files; aborted work publishes no dictionary', async t => {
  const options = workspace(t);
  const runtime = createDictionaryRuntime(options);
  const initial = runtime.service.listSources();
  fs.writeFileSync(path.join(options.directory, 'settings'), 'blocked storage');
  await assert.rejects(runtime.importDictionary({ bytes: makeMdxFixture(), filename: 'demo.mdx' }), (error: any) => error.status === 503);
  assert.deepEqual(runtime.service.listSources(), initial);
  assert.deepEqual(fs.readdirSync(options.importsDir), []);
  assert.deepEqual(discoverImportedDictionaries(options.importsDir), []);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runtime.importDictionary({ bytes: makeMdxFixture(), filename: 'demo.mdx', signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(runtime.service.listSources(), initial);
});

test('import HTTP accepts raw binary and encoded metadata, rejects cross-origin/wrong type and deduplicates imports', async t => {
  const options = workspace(t);
  const runtime = createDictionaryRuntime(options);
  const app = express(); app.use(express.json({ limit: '2mb' })); app.use('/api/dictionary/v1', createDictionaryImportRouter(runtime));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const bytes = makeMdxFixture();
  const upload = (headers: Record<string, string> = {}, body = bytes) => fetch(`${origin}/api/dictionary/v1/import`, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Origin: origin, 'X-Import-Filename': encodeURIComponent('演示.mdx'),
      'X-Dictionary-Language': 'en', 'X-Dictionary-Name': encodeURIComponent('我的 MDX'), ...headers }, body });
  assert.equal((await upload({ Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await upload({ 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await upload({ 'X-Import-Filename': '%bad%' })).status, 400);
  const first = await upload(); assert.equal(first.status, 200);
  const result = await first.json(); assert.equal(result.ok, true); assert.equal(result.imported.name, '我的 MDX');
  assert.equal(result.catalog.sources.find((source: any) => source.id === result.imported.dictionaryId).enabled, true);
  assert.equal((await (await upload()).json()).imported.dictionaryId, result.imported.dictionaryId);
});
