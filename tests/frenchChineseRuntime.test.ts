import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { importFrenchDictionary } from '../scripts/dictionary/import-french';
import { FRENCH_WIKTIONARY_ID, FRENCH_CHINESE_WIKTIONARY_ID } from '../packages/dictionary/server/wiktionaryFrench';
import { DICTIONARY_PROTOCOL_VERSION, DICTIONARY_ENTRY_SCHEMA_VERSION, type DictionaryEntry } from '../packages/dictionary/contracts';

type Runtime = ReturnType<typeof createDictionaryRuntime>;

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-french-chinese-runtime-'));
  const runtimes: Runtime[] = [];
  t.after(async () => {
    for (const runtime of runtimes) {
      runtime.frenchChinese?.close();
      runtime.french?.close();
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-french-chinese-runtime-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const englishFile = path.join(directory, 'english.jsonl');
  const chineseFile = path.join(directory, 'chinese.jsonl');
  await fs.writeFile(englishFile, [
    { lang_code: 'fr', word: 'cheval', pos: 'noun', senses: [{ glosses: ['English fixture: a horse.'] }], forms: [{ form: 'chevaux', tags: ['plural'] }] },
    { lang_code: 'fr', word: 'école', pos: 'noun', senses: [{ glosses: ['English fixture: a school.'] }] },
  ].map(row => JSON.stringify(row)).join('\n'));
  // The Chinese snapshot deliberately has no chevaux entry or plural relation.
  // The English snapshot can supply its explicit form relationship, while each
  // definition and entry identity still belongs to the Chinese edition.
  await fs.writeFile(chineseFile, [
    { lang_code: 'fr', word: 'cheval', pos: 'noun', senses: [{ glosses: ['马。'] }] },
    { lang_code: 'fr', word: 'école', pos: 'noun', senses: [{ glosses: ['学校。'] }] },
  ].map(row => JSON.stringify(row)).join('\n'));
  const frenchDir = path.join(directory, 'english-pack');
  const frenchChineseDir = path.join(directory, 'chinese-pack');
  const englishManifest = await importFrenchDictionary({ sourceFile: englishFile, outputDir: frenchDir, edition: 'en' });
  const chineseManifest = await importFrenchDictionary({ sourceFile: chineseFile, outputDir: frenchChineseDir, edition: 'zh' });
  assert.equal(englishManifest.relationCount, 1);
  assert.equal(chineseManifest.relationCount, 0);
  const create = (options: Parameters<typeof createDictionaryRuntime>[0] = {}) => {
    const runtime = createDictionaryRuntime({ frenchDir, frenchChineseDir, ...options });
    runtimes.push(runtime);
    return runtime;
  };
  return { create, englishManifest, chineseManifest };
}

function assertChineseEntry(entry: DictionaryEntry) {
  assert.equal(entry.dictionaryId, FRENCH_CHINESE_WIKTIONARY_ID);
  assert.equal(entry.language, 'fr');
  assert.equal(entry.schemaVersion, DICTIONARY_ENTRY_SCHEMA_VERSION);
  assert.equal(entry.content.kind, 'structured');
  if (entry.content.kind === 'structured') {
    assert.ok(entry.content.senses.length > 0);
    for (const sense of entry.content.senses) {
      assert.ok(sense.definitions.length > 0);
      assert.ok(sense.definitions.every(definition => definition.language === 'zh'));
      assert.ok(sense.definitions.every(definition => !definition.text.includes('English fixture')));
    }
  }
}

test('the Chinese runtime uses a disabled English French source only for explicit morphology and keeps English defaults stable', async t => {
  const { create } = await fixture(t);
  const baseline = createDictionaryRuntime();
  const runtime = create();
  const surfaces = ['running', 'books', 'studies', 'saw', 'went', 'over time'];
  const expectedIdentities = await baseline.resolveLearningTerms(surfaces);
  assert.deepEqual(expectedIdentities.slice(0, 3).map(ref => ref.stableId), ['run', 'book', 'study']);
  assert.deepEqual(await runtime.resolveLearningTerms(surfaces), expectedIdentities);
  const initialCatalog = runtime.service.listSources();
  assert.equal(initialCatalog.defaultSource, 'native-reviewed');
  assert.deepEqual(initialCatalog.sources.slice(0, 2).map(source => source.id), ['native-reviewed', 'ecdict']);
  assert.deepEqual(initialCatalog.sources.filter(source => source.languages.includes('en')),
    baseline.service.listSources().sources.filter(source => source.languages.includes('en')));

  await runtime.settings.update({
    expectedRevision: runtime.settings.snapshot().settings.revision,
    enabledSources: ['native-reviewed', 'ecdict', FRENCH_CHINESE_WIKTIONARY_ID],
    sourceOrder: runtime.settings.snapshot().settings.sourceOrder,
    defaultSource: 'native-reviewed',
  });
  const catalog = runtime.service.listSources();
  assert.equal(catalog.defaultSource, 'native-reviewed');
  assert.equal(catalog.sources.find(source => source.id === FRENCH_WIKTIONARY_ID)?.enabled, false);
  const chineseSource = catalog.sources.find(source => source.id === FRENCH_CHINESE_WIKTIONARY_ID)!;
  assert.ok(chineseSource.enabled && chineseSource.available);
  const requests = ['chevaux', 'L’ÉCOLE', 'missing-fr-fixture'].map(text => ({
    text, language: 'fr', dictionaryIds: [FRENCH_CHINESE_WIKTIONARY_ID], preferredDefinitionLanguages: ['zh'],
  }));
  const batch = await runtime.service.lookupMany(requests);
  assert.deepEqual(batch.map(result => result.request.text), requests.map(request => request.text));
  assert.deepEqual(batch.map(result => result.status), ['found', 'found', 'not_found']);
  for (const result of batch) {
    assert.equal(result.protocolVersion, DICTIONARY_PROTOCOL_VERSION);
    assert.equal(result.catalogVersion, catalog.catalogVersion);
    assert.deepEqual(result.sources.map(source => source.dictionaryId), [FRENCH_CHINESE_WIKTIONARY_ID]);
    for (const match of result.sources[0].matches) {
      assertChineseEntry(match.entry);
      assert.equal(match.entry.contentVersion, chineseSource.contentVersion);
      const detail = await runtime.service.getEntry({ dictionaryId: match.entry.dictionaryId, entryId: match.entry.entryId });
      assert.equal(detail.status, 'found');
      assert.equal(detail.protocolVersion, result.protocolVersion);
      assert.equal(detail.catalogVersion, result.catalogVersion);
      assert.equal(detail.entry?.contentVersion, match.entry.contentVersion);
      assert.equal(detail.entry?.schemaVersion, match.entry.schemaVersion);
      assert.equal(detail.entry?.entryId, match.entry.entryId);
      assert.deepEqual(detail.entry?.content, match.entry.content);
    }
  }
  const horse = batch[0].sources[0].matches[0];
  assert.equal(horse.matchKind, 'inflection');
  assert.equal(horse.entry.headword, 'cheval');
  const school = batch[1].sources[0].matches[0];
  assert.equal(school.entry.headword, 'école');
  const unselected = await runtime.service.lookup({ text: 'chevaux', language: 'fr' });
  assert.equal(unselected.status, 'found');
  assert.deepEqual(unselected.sources.map(source => source.dictionaryId), [FRENCH_CHINESE_WIKTIONARY_ID]);
  const disabled = await runtime.service.lookup({ text: 'chevaux', language: 'fr', dictionaryIds: [FRENCH_WIKTIONARY_ID] });
  assert.equal(disabled.status, 'invalid_request');
  assert.deepEqual(disabled.sources, []);
  assert.equal((await runtime.service.getEntry({ dictionaryId: FRENCH_WIKTIONARY_ID, entryId: 'fr:1' })).status, 'invalid_request');
  const english = await runtime.service.lookup({ text: 'bank', language: 'en' });
  assert.equal(english.status, 'found');
  assert.deepEqual(english.sources.map(source => source.dictionaryId), ['native-reviewed', 'ecdict']);
  assert.deepEqual(await runtime.resolveLearningTerms(surfaces), expectedIdentities);
});

test('enabling only the Chinese edition still resolves French inflections and existing English learning identities', async t => {
  const { create } = await fixture(t);
  const baseline = createDictionaryRuntime();
  const expected = await baseline.resolveLearningTerms(['dogs', 'running', 'books']);
  const runtime = create({ enabledSources: [FRENCH_CHINESE_WIKTIONARY_ID], defaultSource: FRENCH_CHINESE_WIKTIONARY_ID });
  assert.deepEqual(runtime.service.listSources().sources.filter(source => source.enabled).map(source => source.id),
    [FRENCH_CHINESE_WIKTIONARY_ID]);
  const french = await runtime.service.lookup({ text: 'chevaux', language: 'fr' });
  assert.equal(french.status, 'found');
  assert.deepEqual(french.sources.map(source => source.dictionaryId), [FRENCH_CHINESE_WIKTIONARY_ID]);
  assertChineseEntry(french.sources[0].matches[0].entry);
  assert.equal(french.sources[0].matches[0].entry.headword, 'cheval');
  // All three English surfaces are first resolved after ECDICT was disabled for
  // display: this proves stable identity resolution does not use display cache.
  assert.deepEqual(await runtime.resolveLearningTerms(['dogs', 'running', 'books']), expected);
  const english = await runtime.service.lookup({ text: 'running', language: 'en' });
  assert.equal(english.status, 'not_found');
  assert.deepEqual(english.sources, []);
  assert.deepEqual(english.learningTermRef, expected[1]);
});
