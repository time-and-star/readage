import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { frenchLanguageAdapter, segmentFrenchText } from '../packages/dictionary/languages/french';
import { normalizeFrenchSurface } from '../packages/dictionary/languages/frenchSurface';
import { WiktionaryFrenchAdapter, FRENCH_CHINESE_WIKTIONARY_ID, convertFrenchRecord } from '../packages/dictionary/server/wiktionaryFrench';
import type { DictionaryAdapter } from '../packages/dictionary/contracts';
import { importFrenchDictionary } from '../scripts/dictionary/import-french';
import { createDictionaryService } from '../packages/dictionary/core';
import { createInMemoryDictionary, createExactLanguageAdapter } from '../packages/dictionary/examples/inMemory';
import { createDictionaryRuntime } from '../server/dictionary/runtime';

const rows = [
  { lang_code: 'fr', word: 'cheval', pos: 'noun', senses: [{ glosses: ['Test definition: a horse.'] }], forms: [{ form: 'chevaux', tags: ['plural'] }], sounds: [{ ipa: '/ʃə.val/' }] },
  { lang_code: 'fr', word: 'manger', pos: 'verb', senses: [{ glosses: ['Test definition: to eat.'], examples: [{ text: 'Nous mangeons.', english: 'We eat.' }] }] },
  { lang_code: 'fr', word: 'mangent', pos: 'verb', senses: [{ form_of: [{ word: 'manger' }], glosses: ['third-person plural of manger'] }] },
  { lang_code: 'fr', word: 'manger', pos: 'noun', senses: [{ glosses: ['Test definition: food.'] }] },
  { lang_code: 'fr', word: 'aller', pos: 'verb', senses: [{ glosses: ['Test definition: to go.'] }] },
  { lang_code: 'fr', word: 'allé', pos: 'verb', senses: [{ form_of: [{ word: 'aller' }], glosses: ['past participle of aller'] }], forms: [{ form: 'allés', tags: ['plural'] }] },
  { lang_code: 'fr', word: 'allés', pos: 'verb', senses: [{ form_of: [{ word: 'allé' }], glosses: ['plural of allé'] }] },
  { lang_code: 'fr', word: 'été', pos: 'noun', senses: [{ glosses: ['Test definition: summer.'] }] },
  { lang_code: 'fr', word: 'être', pos: 'verb', senses: [{ glosses: ['Test definition: to be.'] }] },
  { lang_code: 'fr', word: 'été', pos: 'verb', senses: [{ form_of: [{ word: 'être' }], glosses: ['past participle of être'] }] },
  { lang_code: 'fr', word: 'école', pos: 'noun', senses: [{ glosses: ['Test definition: a school.'] }] },
  { lang_code: 'en', word: 'horse', pos: 'noun', senses: [{ glosses: ['Must not be imported.'] }] },
];

test('French segmentation preserves original offsets, accents and elisions without English stemming', () => {
  const text = '  Aujourd’hui, l’homme lit près de l’école. Les chevaux mangent.\n日本語 🙂';
  const segments = segmentFrenchText(text);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  assert.deepEqual(segments.filter(segment => segment.kind === 'term').map(segment => segment.text),
    ['Aujourd’hui', 'homme', 'lit', 'près', 'de', 'école', 'Les', 'chevaux', 'mangent']);
  for (const segment of segments) assert.equal(text.slice(segment.start, segment.end), segment.text);
  assert.equal(normalizeFrenchSurface(' E\u0301COLE '), 'école');
  assert.notEqual(normalizeFrenchSurface('été'), normalizeFrenchSurface('ete'));
  assert.deepEqual(frenchLanguageAdapter.candidates!('L’ÉCOLE').map(candidate => candidate.text), ["l'école", 'école']);
  assert.equal(frenchLanguageAdapter.capabilities.morphology, 'unsupported');
  segments[0].text = 'changed';
  assert.equal(segmentFrenchText(text).map(segment => segment.text).join(''), text);
});

test('a real offline adapter uses dictionary-provided forms, preserves ambiguous matches and language tags', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-french-'));
  let adapter: WiktionaryFrenchAdapter | undefined;
  t.after(async () => {
    adapter?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-french-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sourceFile = path.join(directory, 'source.jsonl');
  await fs.writeFile(sourceFile, rows.map(row => JSON.stringify(row)).join('\n'));
  const pack = path.join(directory, 'pack');
  const manifest = await importFrenchDictionary({ sourceFile, outputDir: pack });
  assert.equal(manifest.entryCount, 7);
  adapter = new WiktionaryFrenchAdapter({ dataDir: pack });
  const service = createDictionaryService({ sourceOrder: ['english-fixture', adapter.metadata.id] });
  service.registerLanguage(frenchLanguageAdapter);
  service.registerDictionary(createInMemoryDictionary({ id: 'english-fixture', language: 'en', entries: [{ id: 'english-school', headword: 'école', definitions: [{ language: 'en', text: 'Must not appear in French results.' }] }] }));
  service.registerDictionary(adapter);
  const result = await service.lookup({ text: 'chevaux', language: 'fr' });
  assert.equal(result.status, 'found');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].matches[0].matchKind, 'inflection');
  const entry = result.sources[0].matches[0].entry;
  assert.equal(entry.headword, 'cheval');
  assert.equal(entry.language, 'fr');
  assert.equal(entry.content.kind, 'structured');
  if (entry.content.kind === 'structured') assert.equal(entry.content.senses[0].definitions[0].language, 'en');
  assert.equal(entry.readings[0].language, 'fr');
  assert.equal((await service.getEntry({ dictionaryId: adapter.metadata.id, entryId: entry.entryId })).entry?.headword, 'cheval');
  const batch = await service.lookupMany(['mangent', 'L’ÉCOLE', 'inventedzz', 'été'].map(text => ({ text, language: 'fr' })));
  assert.deepEqual(batch.map(result => result.status), ['found', 'found', 'not_found', 'found']);
  assert.equal(batch[0].sources[0].matches[0].entry.headword, 'manger');
  assert.equal(batch[0].sources[0].matches.length, 1, 'Verb inflections must not include the homographic noun');
  assert.equal(batch[1].sources[0].matches[0].entry.headword, 'école');
  assert.deepEqual(batch[3].sources[0].matches.map(match => match.entry.headword), ['été', 'être']);
  const examples = batch[0].sources[0].matches[0].entry.content;
  if (examples.kind === 'structured') assert.equal(examples.senses[0].examples[0].text.language, 'fr');
  const chained = await service.lookup({ text: 'allés', language: 'fr' });
  assert.equal(chained.sources[0].matches[0].entry.headword, 'aller');
  assert.equal(chained.sources[0].matches[0].matchKind, 'inflection');
  // No adapter means exact Unicode lookup, without silent French normalization or morphology.
  const exact = createDictionaryService(); exact.registerDictionary(adapter);
  assert.equal((await exact.lookup({ text: 'chevaux', language: 'fr' })).status, 'not_found');
  assert.equal((await exact.lookup({ text: 'cheval', language: 'fr' })).status, 'found');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.lookup({ text: 'cheval', language: 'fr' }, abort.signal));
  const disabled = createDictionaryService({ enabledSources: ['english-fixture'] });
  disabled.registerLanguage(frenchLanguageAdapter); disabled.registerDictionary(adapter);
  assert.equal((await disabled.lookup({ text: 'cheval', language: 'fr' })).status, 'not_found');
});

test('French registration does not alter established English learning identities, and faults remain explicit', async t => {
  const runtime = createDictionaryRuntime();
  const before = await runtime.resolveLearningTerms(['dogs', 'running', 'bank']);
  runtime.service.registerLanguage(createExactLanguageAdapter('fr'));
  runtime.service.registerDictionary(createInMemoryDictionary({ id: 'french-test', language: 'fr', entries: [{ id: 'fr-bank', headword: 'bank', definitions: [{ language: 'en', text: 'Test French entry.' }] }] }));
  assert.deepEqual(await runtime.resolveLearningTerms(['dogs', 'running', 'bank']), before);
  const missing = new WiktionaryFrenchAdapter({ dataDir: path.join(os.tmpdir(), `missing-fr-${Date.now()}`) });
  t.after(() => missing.close());
  const service = createDictionaryService(); service.registerLanguage(frenchLanguageAdapter); service.registerDictionary(missing);
  assert.equal((await service.lookup({ text: 'cheval', language: 'fr' })).status, 'unavailable');
});

test('new data snapshots change versions and a damaged pack never becomes a dictionary miss', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-french-'));
  const adapters: WiktionaryFrenchAdapter[] = [];
  t.after(async () => {
    for (const adapter of adapters) adapter.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-french-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sourceFile = path.join(directory, 'source.jsonl');
  await fs.writeFile(sourceFile, JSON.stringify(rows[0]));
  const first = await importFrenchDictionary({ sourceFile, outputDir: path.join(directory, 'first') });
  await fs.writeFile(sourceFile, JSON.stringify({ ...rows[0], senses: [{ glosses: ['Updated test definition.'] }] }));
  const second = await importFrenchDictionary({ sourceFile, outputDir: path.join(directory, 'second') });
  assert.notEqual(first.contentVersion, second.contentVersion);
  const adapter = new WiktionaryFrenchAdapter({ dataDir: path.join(directory, 'second') }); adapters.push(adapter);
  assert.equal(adapter.metadata.contentVersion, second.contentVersion);
  const found = await adapter.lookup({ text: 'cheval', language: 'fr', candidates: [{ text: 'cheval', kind: 'exact' }] });
  assert.equal(found[0].entry.contentVersion, second.contentVersion);
  adapter.close(); adapters.pop();
  const file = path.join(directory, 'second', 'dictionary.sqlite');
  const bytes = await fs.readFile(file); bytes[bytes.length - 1] ^= 1; await fs.writeFile(file, bytes);
  const damaged = new WiktionaryFrenchAdapter({ dataDir: path.join(directory, 'second') }); adapters.push(damaged);
  const service = createDictionaryService(); service.registerLanguage(frenchLanguageAdapter); service.registerDictionary(damaged);
  assert.equal(damaged.getStatus().available, false);
  assert.equal((await service.lookup({ text: 'cheval', language: 'fr' })).status, 'unavailable');
  await fs.writeFile(sourceFile, '{invalid-json');
  const failed = path.join(directory, 'failed');
  await assert.rejects(importFrenchDictionary({ sourceFile, outputDir: failed }));
  await assert.rejects(fs.access(path.join(failed, 'manifest.json')));
});

test('Chinese edition combines real language fields and retains each source without borrowing English definitions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-french-'));
  const adapters: WiktionaryFrenchAdapter[] = [];
  t.after(async () => {
    for (const adapter of adapters) adapter.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-french-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const simplified = path.join(directory, 'simplified.jsonl');
  const traditional = path.join(directory, 'traditional.jsonl');
  await fs.writeFile(simplified, [
    { lang_code: 'fr', word: 'cheval', pos: 'noun', senses: [{ glosses: ['测试释义：马。'] }], forms: [{ form: 'chevaux', tags: ['plural'] }] },
    { lang_code: 'fr', word: 'manger', pos: 'verb', senses: [{ glosses: ['测试释义：吃。'], examples: [{ text: 'Nous mangeons.', translation: '我们吃饭。', english: 'Must not be tagged Chinese.' }] }] },
    { lang_code: 'fr', word: 'mangent', pos: 'verb', senses: [{ glosses: ['manger的变位'], form_of: [{ word: 'manger' }] }] },
  ].map(row => JSON.stringify(row)).join('\n'));
  await fs.writeFile(traditional, [
    { lang_code: 'fr', word: 'école', pos: 'noun', senses: [{ glosses: ['測試釋義：學校。'] }] },
    { lang_code: 'fr', word: 'aller', pos: 'verb', senses: [{ glosses: ['測試釋義：去。'] }] },
    { lang_code: 'fr', word: 'allé', pos: 'verb', senses: [{ form_of: [{ word: 'aller' }] }], forms: [{ form: 'allés' }] },
    { lang_code: 'zh', word: '学校', pos: 'noun', senses: [{ glosses: ['Other language must not become a French headword.'] }] },
  ].map(row => JSON.stringify(row)).join('\n'));
  const sourceFiles = [simplified, traditional];
  const pack = path.join(directory, 'chinese');
  const manifest = await importFrenchDictionary({ sourceFiles, outputDir: pack, edition: 'zh' });
  assert.equal(manifest.edition, 'zh'); assert.equal(manifest.dictionaryId, FRENCH_CHINESE_WIKTIONARY_ID);
  assert.equal(manifest.definitionLanguage, 'zh'); assert.equal(manifest.sources.length, 2);
  assert.notEqual(manifest.sources[0].sourceSha256, manifest.sources[1].sourceSha256);
  assert.equal(manifest.entryCount, 4); assert.equal(manifest.recordCount, 7);
  const chinese = new WiktionaryFrenchAdapter({ dataDir: pack, edition: 'zh' }); adapters.push(chinese);
  assert.equal(chinese.getStatus().available, true);
  assert.equal(chinese.metadata.name, 'Wiktionary 法中词典'); assert.deepEqual(chinese.metadata.definitionLanguages, ['zh']);
  const englishSource = path.join(directory, 'english.jsonl');
  await fs.writeFile(englishSource, rows.map(row => JSON.stringify(row)).join('\n'));
  const englishPack = path.join(directory, 'english');
  await importFrenchDictionary({ sourceFile: englishSource, outputDir: englishPack });
  const english = new WiktionaryFrenchAdapter({ dataDir: englishPack }); adapters.push(english);
  const service = createDictionaryService({ sourceOrder: [chinese.metadata.id, english.metadata.id] });
  service.registerLanguage(frenchLanguageAdapter); service.registerDictionary(english); service.registerDictionary(chinese);
  const batch = await service.lookupMany(['chevaux', 'mangent', 'L’ÉCOLE', 'allés'].map(text => ({ text, language: 'fr', dictionaryIds: [chinese.metadata.id] })));
  assert.deepEqual(batch.map(result => result.status), ['found', 'found', 'found', 'found']);
  for (const result of batch) {
    assert.equal(result.sources.length, 1); assert.equal(result.sources[0].dictionaryId, chinese.metadata.id);
    for (const match of result.sources[0].matches) {
      assert.equal(match.entry.dictionaryId, chinese.metadata.id); assert.equal(match.entry.language, 'fr');
      assert.equal(match.entry.content.kind, 'structured');
      if (match.entry.content.kind === 'structured') for (const sense of match.entry.content.senses) {
        assert.ok(sense.definitions.every(definition => definition.language === 'zh'));
      }
      assert.ok(match.entry.provenance.some(source => source.kind === 'entry' && source.detail?.startsWith('https://zh.wiktionary.org/')));
    }
  }
  const verb = batch[1].sources[0].matches[0].entry;
  if (verb.content.kind === 'structured') {
    const example = verb.content.senses[0].examples[0];
    assert.deepEqual(example.translations, [{ language: 'zh', text: '我们吃饭。' }]);
    assert.equal(example.text.language, 'fr');
  }
  assert.equal((await service.getEntry({ dictionaryId: chinese.metadata.id, entryId: verb.entryId })).entry?.dictionaryId, chinese.metadata.id);
  const together = await service.lookup({ text: 'chevaux', language: 'fr' });
  assert.deepEqual(together.sources.map(source => source.dictionaryId), [chinese.metadata.id, english.metadata.id]);
  for (const source of together.sources) {
    const entry = source.matches[0].entry;
    if (entry.content.kind === 'structured') assert.equal(entry.content.senses[0].definitions[0].language,
      source.dictionaryId === chinese.metadata.id ? 'zh' : 'en');
  }
  const originalVersion = manifest.contentVersion;
  await fs.appendFile(traditional, '\n' + JSON.stringify({ lang_code: 'fr', word: 'bonjour', pos: 'intj', senses: [{ glosses: ['你好。'] }] }));
  const changed = await importFrenchDictionary({ sourceFiles, outputDir: path.join(directory, 'changed'), edition: 'zh' });
  assert.notEqual(changed.contentVersion, originalVersion, 'Changes in either source snapshot must invalidate the edition version.');
  await assert.rejects(importFrenchDictionary({ sourceFiles: [simplified, simplified], outputDir: path.join(directory, 'duplicate'), edition: 'zh' }));
});

test('edition manifests reject a mismatched adapter while legacy English packs remain readable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-french-'));
  const adapters: WiktionaryFrenchAdapter[] = [];
  t.after(async () => {
    for (const adapter of adapters) adapter.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-french-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sourceFile = path.join(directory, 'source.jsonl');
  await fs.writeFile(sourceFile, JSON.stringify(rows[0]));
  const englishPack = path.join(directory, 'english');
  const englishManifest = await importFrenchDictionary({ sourceFile, outputDir: englishPack });
  const chineseSource = path.join(directory, 'chinese.jsonl');
  await fs.writeFile(chineseSource, JSON.stringify({ lang_code: 'fr', word: 'cheval', pos: 'noun', senses: [{ glosses: ['测试释义：马。'] }] }));
  const chinesePack = path.join(directory, 'chinese');
  const chineseManifest = await importFrenchDictionary({ sourceFile: chineseSource, outputDir: chinesePack, edition: 'zh' });
  for (const options of [{ dataDir: chinesePack }, { dataDir: englishPack, edition: 'zh' as const }]) {
    const wrongEdition = new WiktionaryFrenchAdapter(options); adapters.push(wrongEdition);
    assert.equal(wrongEdition.getStatus().available, false);
    const service = createDictionaryService(); service.registerLanguage(frenchLanguageAdapter); service.registerDictionary(wrongEdition);
    assert.equal((await service.lookup({ text: 'cheval', language: 'fr' })).status, 'unavailable');
  }
  const { edition: _edition, dictionaryId: _id, ...legacyManifest } = englishManifest;
  await fs.writeFile(path.join(englishPack, 'manifest.json'), JSON.stringify(legacyManifest));
  const legacy = new WiktionaryFrenchAdapter({ dataDir: englishPack }); adapters.push(legacy);
  assert.equal(legacy.getStatus().available, true);
  await fs.writeFile(path.join(englishPack, 'manifest.json'), JSON.stringify({ ...legacyManifest, edition: 'en' }));
  const incompleteEdition = new WiktionaryFrenchAdapter({ dataDir: englishPack }); adapters.push(incompleteEdition);
  assert.equal(incompleteEdition.getStatus().available, false, 'A new edition manifest must declare both edition and source ID.');
  const chineseManifestFile = path.join(chinesePack, 'manifest.json');
  for (const fields of [{ dictionaryId: 'wiktionary-fr' }, { edition: 'en' }, { definitionLanguage: 'en' }, { edition: undefined }]) {
    await fs.writeFile(chineseManifestFile, JSON.stringify({ ...chineseManifest, ...fields }));
    const bad = new WiktionaryFrenchAdapter({ dataDir: chinesePack, edition: 'zh' }); adapters.push(bad);
    assert.equal(bad.getStatus().available, false);
  }
});

test('Chinese Wiktionary complete form descriptions are explicit relations, never suffix guesses', () => {
  for (const gloss of ['aller的过去分词', 'aller 的過去分詞。', 'aller的过去分词（阳性单数）', 'aller的过去分词的阴性复数形式。', 'aller的陰性單數過去分詞。']) {
    const converted = convertFrenchRecord({ lang_code: 'fr', word: 'allé', pos: 'verb', senses: [{ glosses: [gloss] }] }, 'fixture', 'fixture-version', 'zh');
    assert.equal(converted.entry, null, 'Pure form descriptions must not hide a real lemma definition.');
    assert.deepEqual(converted.links, [{ surface: 'allé', target: 'aller', pos: 'verb', kind: 'inflection' }]);
  }
  for (const gloss of ['an的复数形', 'an 的複數。', 'an的阳性复数形式。']) {
    const converted = convertFrenchRecord({ lang_code: 'fr', word: 'ans', pos: 'unknown', senses: [{ glosses: [gloss] }] }, 'fixture', 'fixture-version', 'zh');
    assert.equal(converted.entry, null); assert.equal(converted.links[0].target, 'an'); assert.equal(converted.links[0].pos, '');
  }
  const explicitConjugation = convertFrenchRecord({ lang_code: 'fr', word: 'sommes', pos: 'verb', senses: [{ glosses: ['être的变位形式'] }] }, 'fixture', 'fixture-version', 'zh');
  assert.equal(explicitConjugation.links[0].target, 'être');
  for (const gloss of ['与aller的过去分词有关的用法', 'aller的过去分词，另有文学含义', '法语规则一般可删去结尾s']) {
    const preserved = convertFrenchRecord({ lang_code: 'fr', word: 'allé', pos: 'verb', senses: [{ glosses: [gloss] }] }, 'fixture', 'fixture-version', 'zh');
    assert.ok(preserved.entry); assert.equal(preserved.links.length, 0);
  }
  const english = convertFrenchRecord({ lang_code: 'fr', word: 'allé', pos: 'verb', senses: [{ glosses: ['aller的过去分词'] }] }, 'fixture', 'fixture-version');
  assert.ok(english.entry); assert.equal(english.links.length, 0, 'Chinese form-reference parsing is edition-specific.');
});

test('optional morphology verifies missing French forms without mixing definitions, source settings or POS', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-french-'));
  const adapters: WiktionaryFrenchAdapter[] = [];
  t.after(async () => {
    for (const adapter of adapters) adapter.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-french-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const englishSource = path.join(directory, 'english.jsonl');
  await fs.writeFile(englishSource, [...rows,
    { lang_code: 'fr', word: 'livre', pos: 'noun', senses: [{ glosses: ['Test definition: a book.'] }], forms: [{ form: 'livres', tags: ['plural'] }] },
  ].map(row => JSON.stringify(row)).join('\n'));
  const englishPack = path.join(directory, 'english');
  await importFrenchDictionary({ sourceFile: englishSource, outputDir: englishPack });
  const english = new WiktionaryFrenchAdapter({ dataDir: englishPack }); adapters.push(english);
  const chineseSource = path.join(directory, 'chinese.jsonl');
  await fs.writeFile(chineseSource, [
    { lang_code: 'fr', word: 'cheval', pos: 'noun', senses: [{ glosses: ['测试释义：马。'] }] },
    { lang_code: 'fr', word: 'manger', pos: 'verb', senses: [{ glosses: ['测试释义：吃。'] }] },
    { lang_code: 'fr', word: 'manger', pos: 'noun', senses: [{ glosses: ['测试释义：食物。'] }] },
    { lang_code: 'fr', word: 'aller', pos: 'verb', senses: [{ glosses: ['测试释义：去。'] }] },
    { lang_code: 'fr', word: 'allé', pos: 'verb', senses: [{ glosses: ['aller的过去分词'] }] },
    { lang_code: 'fr', word: 'livre', pos: 'unknown', senses: [{ glosses: ['测试释义：书。'] }] },
    { lang_code: 'fr', word: 'être', pos: 'verb', senses: [{ glosses: ['测试释义：是。'] }] },
    { lang_code: 'fr', word: 'sommes', pos: 'verb', senses: [{ glosses: ['être的变位形式'] }] },
  ].map(row => JSON.stringify(row)).join('\n'));
  const chinesePack = path.join(directory, 'chinese');
  const manifest = await importFrenchDictionary({ sourceFile: chineseSource, outputDir: chinesePack, edition: 'zh' });
  const chinese = new WiktionaryFrenchAdapter({ dataDir: chinesePack, edition: 'zh', morphologyAdapter: english }); adapters.push(chinese);
  assert.notEqual(chinese.metadata.contentVersion, manifest.contentVersion);
  const service = createDictionaryService({ enabledSources: [chinese.metadata.id] });
  service.registerLanguage(frenchLanguageAdapter); service.registerDictionary(english); service.registerDictionary(chinese);
  const batch = await service.lookupMany(['chevaux', 'mangent', 'allés', 'livres'].map(text => ({ text, language: 'fr' })));
  assert.deepEqual(batch.map(result => result.status), ['found', 'found', 'found', 'found']);
  assert.deepEqual(batch.map(result => result.sources[0].matches[0].entry.headword), ['cheval', 'manger', 'aller', 'livre']);
  assert.equal(batch[1].sources[0].matches.length, 1, 'Verified verb forms cannot return a homographic noun definition.');
  for (const result of batch) {
    assert.equal(result.sources.length, 1, 'The disabled English display source must not become a result source.');
    const match = result.sources[0].matches[0];
    assert.equal(match.matchKind, 'inflection'); assert.equal(match.entry.dictionaryId, chinese.metadata.id);
    assert.equal(match.entry.contentVersion, chinese.metadata.contentVersion);
    assert.ok(match.entry.provenance.some(source => source.kind === 'morphology' && source.label === '词形：英文维基词典'));
    const relation = match.entry.extensions?.['dictionary.morphology'] as { surface: string; headword: string; dictionaryId: string };
    assert.equal(relation.surface, result.request.text); assert.equal(relation.headword, match.entry.headword); assert.equal(relation.dictionaryId, english.metadata.id);
    if (match.entry.content.kind === 'structured') assert.ok(match.entry.content.senses.every(sense => sense.definitions.every(definition => definition.language === 'zh')));
    const detail = await service.getEntry({ dictionaryId: chinese.metadata.id, entryId: match.entry.entryId });
    assert.equal(detail.entry?.contentVersion, chinese.metadata.contentVersion);
  }
  const independent = new WiktionaryFrenchAdapter({ dataDir: chinesePack, edition: 'zh' }); adapters.push(independent);
  const standalone = createDictionaryService(); standalone.registerLanguage(frenchLanguageAdapter); standalone.registerDictionary(independent);
  assert.equal((await standalone.lookup({ text: 'cheval', language: 'fr' })).status, 'found');
  assert.equal((await standalone.lookup({ text: 'chevaux', language: 'fr' })).status, 'not_found');
  assert.equal((await standalone.lookup({ text: 'allé', language: 'fr' })).sources[0].matches[0].entry.headword, 'aller');
  assert.equal((await standalone.lookup({ text: 'sommes', language: 'fr' })).sources[0].matches[0].entry.headword, 'être');
  const newMorphology: DictionaryAdapter = { metadata: { ...english.metadata, contentVersion: 'morphology-new-version' },
    lookup: (...args) => english.lookup(...args), getEntry: (...args) => english.getEntry(...args) };
  const reversioned = new WiktionaryFrenchAdapter({ dataDir: chinesePack, edition: 'zh', morphologyAdapter: newMorphology }); adapters.push(reversioned);
  assert.notEqual(reversioned.metadata.contentVersion, chinese.metadata.contentVersion);
  const normalizedOnly: DictionaryAdapter = { metadata: english.metadata,
    lookup: async () => [{ ...(await english.lookup({ text: 'cheval', language: 'fr', candidates: [{ text: 'cheval', kind: 'exact' }] }))[0], matchKind: 'normalized' }],
    getEntry: (...args) => english.getEntry(...args) };
  const strict = new WiktionaryFrenchAdapter({ dataDir: chinesePack, edition: 'zh', morphologyAdapter: normalizedOnly }); adapters.push(strict);
  assert.deepEqual(await strict.lookup({ text: 'chevaux', language: 'fr', candidates: [{ text: 'chevaux', kind: 'exact' }] }), [], 'Normalized matches alone never establish an inflection.');
  const neverFinishes: DictionaryAdapter = { metadata: english.metadata,
    lookup: () => new Promise(() => {}), getEntry: (...args) => english.getEntry(...args) };
  const cancellable = new WiktionaryFrenchAdapter({ dataDir: chinesePack, edition: 'zh', morphologyAdapter: neverFinishes }); adapters.push(cancellable);
  const abort = new AbortController();
  const pending = cancellable.lookup({ text: 'chevaux', language: 'fr', candidates: [{ text: 'chevaux', kind: 'exact' }] }, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' }, 'Cancelling a slow relation dependency remains a cancellation.');
  english.close();
  assert.equal((await service.lookup({ text: 'cheval', language: 'fr' })).status, 'found', 'An exact Chinese entry remains available if optional morphology fails.');
  assert.equal((await service.lookup({ text: 'allé', language: 'fr' })).status, 'found', 'Self-reported Chinese forms remain independent.');
  assert.equal((await service.lookup({ text: 'chevaux', language: 'fr' })).status, 'unavailable', 'A failed relation dependency must not become a dictionary miss.');
});
