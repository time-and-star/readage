import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { prepareAndroidDictionaries } from '../scripts/prepare-android-dictionaries';
import { importFrenchDictionary } from '../scripts/dictionary/import-french';
import { importJapaneseDictionary } from '../scripts/dictionary/import-japanese';
import { WordNetAdapter } from '../packages/dictionary/server/wordnet';
import { WiktionaryFrenchAdapter } from '../packages/dictionary/server/wiktionaryFrench';
import { WiktionaryJapaneseAdapter } from '../packages/dictionary/server/wiktionaryJapanese';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const imported = 'data/dictionary/imported';
async function write(root: string, relative: string, content: string | Buffer) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}
async function fixture(t: TestContext, readers: Array<{ close(): void }> = []) {
  const parent = path.resolve('tmp/android-dictionary-resource-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'fixture-'));
  t.after(async () => {
    for (const reader of readers) reader.close();
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('fixture-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const financial = '00000000 00 n 01 bank 0 000 | a fixture financial institution; "I went to the bank"\n';
  const offset = Buffer.byteLength(financial);
  const river = `${String(offset).padStart(8, '0')} 00 n 01 bank 0 000 | sloping land beside water\n`;
  const phraseOffset = offset + Buffer.byteLength(river);
  const phrase = `${String(phraseOffset).padStart(8, '0')} 00 n 01 ice_cream 0 000 | a frozen dessert\n`;
  const files: Record<string, string> = { 'LICENSE.txt': 'Synthetic fixture license, no production data.' };
  for (const pos of ['noun', 'verb', 'adj', 'adv']) { files[`index.${pos}`] = ''; files[`data.${pos}`] = ''; }
  files['data.noun'] = financial + river + phrase;
  files['index.noun'] = `bank n 2 0 2 0 ${String(offset).padStart(8, '0')} 00000000\nice_cream n 1 0 1 0 ${String(phraseOffset).padStart(8, '0')}\n`;
  for (const [name, content] of Object.entries(files)) await write(root, `${imported}/wordnet-3.1/${name}`, content);
  await write(root, `${imported}/wordnet-3.1/manifest.json`, JSON.stringify({ format: 'wordnet-import.v1', release: '3.1', headwordCount: 2,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { bytes: Buffer.byteLength(content), sha256: sha256(content) }])) }));
  for (const edition of ['en', 'zh'] as const) {
    const sourceFile = path.join(root, `french-${edition}.jsonl`);
    await fs.writeFile(sourceFile, JSON.stringify({ lang_code: 'fr', word: 'cheval', pos: 'noun',
      senses: [{ glosses: [edition === 'zh' ? '马（测试夹具）' : 'a horse (synthetic fixture)'],
        examples: [{ text: 'Le cheval est calme.', ...(edition === 'zh' ? { translation: '马很安静。' } : { english: 'The horse is calm.' }) }] }],
      forms: edition === 'en' ? [{ form: 'chevaux', tags: ['plural'] }] : [], sounds: [{ ipa: '/ʃə.val/' }] }));
    await importFrenchDictionary({ sourceFile, edition,
      outputDir: path.join(root, imported, edition === 'zh' ? 'wiktionary-fr-zh' : 'wiktionary-fr') });
  }
  const sourceFile = path.join(root, 'japanese.jsonl');
  await fs.writeFile(sourceFile, JSON.stringify({ lang_code: 'ja', word: '猫', pos: 'noun', senses: [{ glosses: ['猫（测试夹具）'],
    examples: [{ text: '猫がいます。', translation: '有一只猫。' }] }], sounds: [{ other: 'ねこ' }] }));
  await importJapaneseDictionary({ sourceFile, outputDir: path.join(root, imported, 'wiktionary-ja-zh') });
  return { root, destination: path.join(root, 'prepared-assets'), cache: path.join(root, 'cache') };
}
async function filesBelow(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await filesBelow(path.join(root, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

test('Android release includes exactly the four verified dictionaries with Node metadata and hashed formal files', async t => {
  const readers: Array<{ close(): void }> = [];
  const options = await fixture(t, readers);
  const french = new WiktionaryFrenchAdapter({ dataDir: path.join(options.root, imported, 'wiktionary-fr') });
  const frenchZh = new WiktionaryFrenchAdapter({ dataDir: path.join(options.root, imported, 'wiktionary-fr-zh'), edition: 'zh', morphologyAdapter: french });
  const japanese = new WiktionaryJapaneseAdapter({ dataDir: path.join(options.root, imported, 'wiktionary-ja-zh') });
  readers.push(french, frenchZh, japanese);
  const wordnet = new WordNetAdapter({ dataDir: path.join(options.root, imported, 'wordnet-3.1') });
  const catalog = await prepareAndroidDictionaries(options);
  assert.equal(catalog.format, 'readage-android-dictionaries.v1');
  assert.deepEqual(catalog.sources.map(source => source.queryKind), ['wordnet', 'french-en', 'french-zh', 'japanese']);
  const adapters = [wordnet, french, frenchZh, japanese];
  for (const [index, source] of catalog.sources.entries()) {
    assert.deepEqual(source.metadata, { ...adapters[index].metadata,
      entryCount: adapters[index].metadata.entryCount ?? (index === 0 ? 2 : undefined) });
    assert.deepEqual(source.files.map(file => file.name), ['dictionary.sqlite', 'manifest.json', 'LICENSE.txt']);
    for (const item of source.files) {
      const bytes = await fs.readFile(path.join(options.destination, 'canonical', source.metadata.id, item.name));
      assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
    }
  }
  assert.equal((await filesBelow(options.destination)).length, 13);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.destination, 'catalog.json'), 'utf8')), catalog);
});

test('WordNet canonical SQLite preserves ranked senses, phrase identities, examples and provenance', async t => {
  const options = await fixture(t);
  const catalog = await prepareAndroidDictionaries(options);
  const adapter = new WordNetAdapter({ dataDir: path.join(options.root, imported, 'wordnet-3.1') });
  const db = new DatabaseSync(path.join(options.destination, 'canonical/wordnet/dictionary.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, headword, payload FROM entries ORDER BY headword').all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.id, row.headword);
      const entry = JSON.parse(String(row.payload));
      assert.deepEqual(entry, await adapter.getEntry(String(row.id)));
      assert.equal(entry.contentVersion, catalog.sources[0].metadata.contentVersion);
    }
    const entry = JSON.parse(String(rows[0].payload));
    assert.deepEqual(entry.content.senses.map((sense: any) => sense.definitions[0].text), ['sloping land beside water', 'a fixture financial institution']);
    assert.equal(entry.content.senses[1].examples[0].text.text, 'I went to the bank');
    assert.equal(rows[1].headword, 'ice cream');
  } finally { db.close(); }
});

test('preparation excludes raw dumps/backups/settings and leaves learning and source fixtures unchanged', async t => {
  const options = await fixture(t);
  await write(options.root, `${imported}/wiktionary-fr/raw-dump.jsonl`, 'private fixture raw data');
  await write(options.root, `${imported}/wiktionary-fr/notes.txt`, 'private fixture notes');
  await write(options.root, `${imported}/wiktionary-fr-firstpass/dictionary.sqlite`, 'obsolete fixture database');
  await write(options.root, `${imported}/wiktionary-ja-zh-before-counter-fix/dictionary.sqlite`, 'obsolete fixture database');
  await write(options.root, 'local-data/library/learning.sqlite', 'untouched isolated learning fixture');
  await write(options.root, 'local-data/dictionary/settings.json', '{"user":"isolated fixture"}');
  const protectedPaths = [`${imported}/wiktionary-fr/dictionary.sqlite`, `${imported}/wiktionary-fr/raw-dump.jsonl`,
    'local-data/library/learning.sqlite', 'local-data/dictionary/settings.json'];
  const before = await Promise.all(protectedPaths.map(relative => fs.readFile(path.join(options.root, relative))));
  await prepareAndroidDictionaries(options);
  const output = await filesBelow(options.destination);
  assert.ok(output.every(relative => relative === 'catalog.json' || /^canonical\/(wordnet|wiktionary-fr|wiktionary-fr-zh|wiktionary-ja-zh)\/(dictionary\.sqlite|manifest\.json|LICENSE\.txt)$/.test(relative)));
  for (const [index, relative] of protectedPaths.entries()) assert.deepEqual(await fs.readFile(path.join(options.root, relative)), before[index], relative);
});

test('WordNet cache is reused only with a matching receipt and repaired after damage', async t => {
  const options = await fixture(t);
  const first = await prepareAndroidDictionaries(options);
  const filename = (await fs.readdir(options.cache)).find(name => name.endsWith('.sqlite'))!;
  const database = path.join(options.cache, filename);
  const original = await fs.readFile(database);
  const fixedDate = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(database, fixedDate, fixedDate);
  assert.deepEqual(await prepareAndroidDictionaries(options), first);
  assert.equal((await fs.stat(database)).mtimeMs, fixedDate.getTime(), 'verified cache is not regenerated');
  await fs.writeFile(database, 'damaged isolated cache');
  const repaired = await prepareAndroidDictionaries(options);
  assert.deepEqual(await fs.readFile(database), original);
  assert.deepEqual(repaired, first);
  assert.deepEqual((await fs.readdir(options.cache)).sort(), [filename, `${filename}.json`].sort());
});

test('corrupt or missing formal source prevents publishing a new catalogue', async t => {
  const options = await fixture(t);
  await prepareAndroidDictionaries(options);
  const catalogFile = path.join(options.destination, 'catalog.json');
  const before = await fs.readFile(catalogFile);
  const japanese = path.join(options.root, imported, 'wiktionary-ja-zh/dictionary.sqlite');
  await fs.appendFile(japanese, 'corrupt fixture bytes');
  await assert.rejects(prepareAndroidDictionaries(options), /Android 词典资源缺失或校验失败：wiktionary-ja-zh/);
  assert.deepEqual(await fs.readFile(catalogFile), before, 'previous completed catalog is preserved after failed preparation');
  await fs.rm(path.join(options.root, imported, 'wiktionary-fr-zh/manifest.json'));
  const destination = path.join(options.root, 'new-output');
  await assert.rejects(prepareAndroidDictionaries({ ...options, destination }), /wiktionary-fr-zh/);
  await assert.rejects(fs.stat(path.join(destination, 'catalog.json')), { code: 'ENOENT' });
});
