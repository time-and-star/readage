import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildDesktopDictionaryBundle, inspectDesktopDictionarySources, verifyDesktopDictionaryBundle } from '../scripts/desktop-bundle-dictionaries.mjs';
import { resolveReleasedDictionaryDirectories } from '../server/dictionary/releasedResources';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { importFrenchDictionary } from '../scripts/dictionary/import-french';
import { importJapaneseDictionary } from '../scripts/dictionary/import-japanese';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function write(workspace: string, relative: string, content: string | Buffer) {
  const filename = path.join(workspace, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

async function fixture(t: TestContext, runtimes: ReturnType<typeof createDictionaryRuntime>[] = []) {
  const fixtureRoot = path.resolve('tmp/desktop-dictionary-tests');
  await fs.mkdir(fixtureRoot, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(fixtureRoot, 'fixture-'));
  t.after(async () => {
    for (const runtime of runtimes) {
      runtime.french?.close(); runtime.frenchChinese?.close(); runtime.japaneseChinese?.close();
    }
    assert.equal(path.dirname(path.resolve(workspace)), fixtureRoot);
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const wordnet = 'data/dictionary/imported/wordnet-3.1';
  const wordnetData = '00000000 00 n 01 bank 0 000 | a fixture financial institution\n';
  const files: Record<string, string> = { 'LICENSE.txt': 'Synthetic WordNet test fixture license.' };
  for (const pos of ['adj', 'adv', 'noun', 'verb']) {
    files[`data.${pos}`] = pos === 'noun' ? wordnetData : '';
    files[`index.${pos}`] = pos === 'noun' ? 'bank n 1 0 1 0 00000000\n' : '';
  }
  for (const [name, bytes] of Object.entries(files)) await write(workspace, `${wordnet}/${name}`, bytes);
  await write(workspace, `${wordnet}/manifest.json`, JSON.stringify({ format: 'wordnet-import.v1', release: '3.1',
    headwordCount: 1, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name,
      { bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) }])) }));
  for (const edition of ['en', 'zh'] as const) {
    const sourceFile = path.join(workspace, `french-${edition}.jsonl`);
    await fs.writeFile(sourceFile, JSON.stringify({ lang_code: 'fr', word: 'cheval', pos: 'noun',
      senses: [{ glosses: [edition === 'zh' ? '马（夹具）' : 'a horse (fixture)'] }],
      forms: edition === 'en' ? [{ form: 'chevaux', tags: ['plural'] }] : [] }));
    await importFrenchDictionary({ sourceFile, edition,
      outputDir: path.join(workspace, 'data/dictionary/imported', edition === 'zh' ? 'wiktionary-fr-zh' : 'wiktionary-fr') });
  }
  const japaneseFile = path.join(workspace, 'japanese.jsonl');
  await fs.writeFile(japaneseFile, JSON.stringify({ lang_code: 'ja', word: '猫', pos: 'noun', senses: [{ glosses: ['猫（夹具）'] }] }));
  await importJapaneseDictionary({ sourceFile: japaneseFile, outputDir: path.join(workspace, 'data/dictionary/imported/wiktionary-ja-zh') });
  return workspace;
}

test('the released bundle includes only validated canonical dictionaries, manifests and licenses', async t => {
  const workspace = await fixture(t);
  await write(workspace, 'data/dictionary/imported/wiktionary-fr/.env', 'fixture-not-a-release');
  await write(workspace, 'data/dictionary/imported/wiktionary-fr/personal-notes.txt', 'private fixture');
  await write(workspace, 'local-data/library/learning.sqlite', 'untouched fixture learning file');
  await write(workspace, 'local-data/dictionary/settings.json', '{"fixture":true}');
  const before = await fs.readFile(path.join(workspace, 'local-data/library/learning.sqlite'));
  const bundle = await buildDesktopDictionaryBundle({ workspace });
  assert.equal(bundle.dictionaries.length, 4);
  assert.equal(bundle.files.length, 19);
  assert.ok(!bundle.files.some(file => /\.env|personal|local-data/.test(file.path)));
  assert.equal(bundle.bundleId, (await inspectDesktopDictionarySources(workspace)).bundleId);
  assert.equal((await verifyDesktopDictionaryBundle(bundle.directory)).bundleId, bundle.bundleId);
  for (const entry of bundle.files) {
    const bytes = await fs.readFile(path.join(bundle.directory, entry.path));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(sha256(bytes), entry.sha256);
  }
  assert.deepEqual(await fs.readFile(path.join(workspace, 'local-data/library/learning.sqlite')), before);
  assert.equal(await fs.readFile(path.join(workspace, 'local-data/dictionary/settings.json'), 'utf8'), '{"fixture":true}');
  assert.equal(await fs.readFile(path.join(workspace, 'data/dictionary/imported/wiktionary-fr/personal-notes.txt'), 'utf8'), 'private fixture');
});

test('a fresh installed workspace can use all four read-only released sources without migration', async t => {
  const runtimes: ReturnType<typeof createDictionaryRuntime>[] = [];
  const workspace = await fixture(t, runtimes);
  const bundle = await buildDesktopDictionaryBundle({ workspace });
  const fresh = path.join(workspace, 'fresh-user');
  await fs.mkdir(fresh);
  const directories = resolveReleasedDictionaryDirectories({ READGE_RELEASED_DICTIONARIES_ROOT: bundle.directory }, fresh);
  assert.equal(Object.keys(directories).length, 4);
  const runtime = createDictionaryRuntime({ ...directories, dataDir: path.join(fresh, 'missing-ecdict'),
    enabledSources: ['native-reviewed', 'wordnet', 'wiktionary-fr', 'wiktionary-fr-zh', 'wiktionary-ja-zh'] });
  runtimes.push(runtime);
  const sources = runtime.service.listSources().sources;
  for (const id of ['wordnet', 'wiktionary-fr', 'wiktionary-fr-zh', 'wiktionary-ja-zh']) assert.equal(sources.find(item => item.id === id)?.available, true, id);
  assert.equal((await runtime.service.lookup({ text: 'bank', language: 'en', dictionaryIds: ['wordnet'] })).status, 'found');
  const french = await runtime.service.lookup({ text: 'chevaux', language: 'fr', dictionaryIds: ['wiktionary-fr-zh'] });
  assert.equal(french.status, 'found');
  assert.equal(french.sources[0].matches[0].entry.headword, 'cheval');
  assert.equal((await runtime.service.lookup({ text: '猫', language: 'ja', dictionaryIds: ['wiktionary-ja-zh'] })).status, 'found');
  assert.deepEqual(await fs.readdir(fresh), [], 'released lookups do not create personal files');
  for (const item of bundle.dictionaries.filter(item => item.id !== 'wordnet')) {
    assert.deepEqual((await fs.readdir(path.join(bundle.directory, item.directory))).sort(), ['LICENSE.txt', 'dictionary.sqlite', 'manifest.json']);
  }
});

test('explicit and personal dictionary locations keep their precedence and saved settings are preserved', async t => {
  const runtimes: ReturnType<typeof createDictionaryRuntime>[] = [];
  const workspace = await fixture(t, runtimes);
  const bundle = await buildDesktopDictionaryBundle({ workspace });
  const explicit = path.join(workspace, 'custom-french');
  const result = resolveReleasedDictionaryDirectories({ READGE_RELEASED_DICTIONARIES_ROOT: bundle.directory,
    DICTIONARY_FRENCH_DIR: explicit }, workspace);
  assert.equal(result.frenchDir, explicit);
  assert.equal(result.wordnetDir, path.join(workspace, 'data/dictionary/imported/wordnet-3.1'));
  const settingsFile = path.join(workspace, 'saved-preferences.json');
  const saved = JSON.stringify({ version: 'dictionary-settings.v1', revision: 'settings:old-fixture',
    enabledSources: ['ecdict'], sourceOrder: ['ecdict', 'native-reviewed'], defaultSource: 'ecdict' });
  await fs.writeFile(settingsFile, saved);
  const runtime = createDictionaryRuntime({ ...result, settingsFile, dataDir: path.join(workspace, 'missing-ecdict') });
  runtimes.push(runtime);
  assert.equal(runtime.service.listSources().defaultSource, 'ecdict');
  assert.deepEqual(runtime.settings.snapshot().settings.enabledSources, ['ecdict']);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), saved, 'adding released sources must not rewrite preferences');
});

test('corrupt source bytes and broken release licenses stop publication without changing user data', async t => {
  const workspace = await fixture(t);
  const bundle = await buildDesktopDictionaryBundle({ workspace });
  const fresh = path.join(workspace, 'fresh');
  await fs.mkdir(fresh);
  await fs.appendFile(path.join(bundle.directory, 'dictionaries/wiktionary-fr-zh/LICENSE.txt'), 'changed');
  assert.throws(() => resolveReleasedDictionaryDirectories({ READGE_RELEASED_DICTIONARIES_ROOT: bundle.directory }, fresh), /许可校验失败/);
  await assert.rejects(verifyDesktopDictionaryBundle(bundle.directory), /发布词典资源校验失败/);
  await fs.appendFile(path.join(workspace, 'data/dictionary/imported/wiktionary-ja-zh/dictionary.sqlite'), 'changed');
  await assert.rejects(buildDesktopDictionaryBundle({ workspace }), /发布词典校验失败/);
  assert.ok(await fs.stat(path.join(bundle.directory, 'manifest.json')), 'failed publication leaves the previous generated bundle');
});
