import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { japaneseLanguageAdapter, segmentJapaneseText } from '../packages/dictionary/languages/japanese';
import { normalizeJapaneseSurface } from '../packages/dictionary/languages/japaneseSurface';
import { WiktionaryJapaneseAdapter, JAPANESE_CHINESE_WIKTIONARY_ID, convertJapaneseRecord } from '../packages/dictionary/server/wiktionaryJapanese';
import { importJapaneseDictionary } from '../scripts/dictionary/import-japanese';
import { createDictionaryService } from '../packages/dictionary/core';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { createInMemoryDictionary } from '../packages/dictionary/examples/inMemory';

const rows = [
  { lang_code: 'ja', word: '学校', pos: 'noun', senses: [{ glosses: ['学校（测试义项）'] }], forms: [{ form: '学校', tags: ['canonical'], ruby: [['学', 'がっ'], ['校', 'こう']] }] },
  { lang_code: 'ja', word: '猫', pos: 'noun', senses: [{ glosses: ['猫（测试义项）'] }], sounds: [{ other: 'ねこ', ipa: '[neko]' }], forms: [{ form: 'ネコ', tags: ['alternative'] }] },
  { lang_code: 'ja', word: '食べる', pos: 'verb', senses: [{ glosses: ['吃（测试义项）'], examples: [{ text: 'ご飯を食べる。', translation: '吃饭。' }] }], forms: [
    { form: '食べる', tags: ['canonical'], ruby: [['食', 'た']] },
    { form: '食べ', tags: ['continuative'] }, { form: '食べて', source: 'inflection table', hiragana: 'たべて' },
    { form: '食べます', source: 'inflection table', tags: ['formal'], hiragana: 'たべます' },
  ] },
  { lang_code: 'ja', word: '読む', pos: 'verb', senses: [{ glosses: ['阅读（测试义项）'] }], forms: [
    { form: '読んで', source: 'inflection table', hiragana: 'よんで' },
    { form: '読ます', source: 'inflection table', tags: ['causative'] },
  ] },
  { lang_code: 'ja', word: '読む', pos: 'noun', senses: [{ glosses: ['同形名词（测试义项）'] }] },
  { lang_code: 'ja', word: '學校', pos: 'noun', senses: [{ alt_of: [{ word: '学校' }], glosses: ['学校的旧字体'] }] },
  { lang_code: 'en', word: 'cat', pos: 'noun', senses: [{ glosses: ['English must not enter the Japanese pack.'] }] },
  { lang_code: 'ja', word: '電車', pos: 'noun', senses: [{ glosses: ['电车（测试义项）'] }], forms: [{ form: '本', raw_tags: ['量詞'] }] },
  { lang_code: 'ja', word: '本', pos: 'noun', senses: [{ glosses: ['书（测试义项）'] }] },
];

test('Japanese segmentation is lossless, joins lexical inflections, and preserves noun/copula boundaries', () => {
  const text = '  学校の図書館で本を読んで、ご飯を食べました。\n猫です。雨でした。何ですか。目から涙。火だけ。手まで。雨だから。行きませんでした。🙂';
  const segments = segmentJapaneseText(text);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  for (const segment of segments) assert.equal(text.slice(segment.start, segment.end), segment.text);
  const terms = segments.filter(segment => segment.kind === 'term').map(segment => segment.text);
  for (const expected of ['学校', '図書館', '本', '読んで', '食べました', '行きませんでした', '猫', '雨', '何', '目', '火', '手']) assert.ok(terms.includes(expected), expected);
  assert.ok(!terms.includes('猫です') && !terms.includes('雨でした') && !terms.includes('何です'));
  assert.equal(normalizeJapaneseSurface(' ﾈｺ '), 'ネコ');
  assert.notEqual(normalizeJapaneseSurface('は'), normalizeJapaneseSurface('ば'));
  assert.deepEqual(japaneseLanguageAdapter.candidates!(' 食べました ').map(candidate => candidate.text), ['食べました']);
  assert.equal(japaneseLanguageAdapter.capabilities.morphology, 'unsupported');
  segments[0].text = 'changed';
  assert.equal(segmentJapaneseText(text).map(segment => segment.text).join(''), text);
});

test('Japanese records retain Chinese definitions, ruby okurigana, and only verified polite roots', () => {
  const converted = convertJapaneseRecord(rows[2], 'entry', 'test');
  assert.equal(converted.entry?.language, 'ja');
  assert.ok(converted.entry?.readings.some(reading => reading.text === 'たべる' && reading.notation === 'kana'));
  assert.ok(converted.links.some(link => link.surface === '食べました' && link.target === '食べる' && link.kind === 'inflection'));
  assert.ok(converted.links.some(link => link.surface === 'たべませんでした'));
  const content = converted.entry!.content;
  assert.equal(content.kind, 'structured');
  if (content.kind === 'structured') {
    assert.equal(content.senses[0].definitions[0].language, 'zh');
    assert.equal(content.senses[0].examples[0].text.language, 'ja');
    assert.equal(content.senses[0].examples[0].translations![0].language, 'zh');
  }
  const causative = convertJapaneseRecord(rows[3], 'causative', 'test');
  assert.ok(!causative.links.some(link => link.surface === '読ました'), 'A causative ending in ます is not a polite verb.');
  assert.equal(convertJapaneseRecord(rows[6], 'english', 'test').entry, null);
});

test('offline Japanese pack resolves script variants, kana and inflections with correct POS and faults', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-japanese-'));
  const adapters: WiktionaryJapaneseAdapter[] = [];
  t.after(async () => {
    for (const adapter of adapters) adapter.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-japanese-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sourceFile = path.join(directory, 'source.jsonl');
  await fs.writeFile(sourceFile, rows.map(row => JSON.stringify(row)).join('\n'));
  const pack = path.join(directory, 'pack');
  const manifest = await importJapaneseDictionary({ sourceFile, outputDir: pack });
  assert.equal(manifest.entryCount, 7);
  assert.equal(manifest.headwordCount, 6);
  assert.ok(manifest.relationCount > 0 && manifest.readingCount > 0);
  const adapter = new WiktionaryJapaneseAdapter({ dataDir: pack }); adapters.push(adapter);
  const service = createDictionaryService(); service.registerLanguage(japaneseLanguageAdapter); service.registerDictionary(adapter);
  const batch = await service.lookupMany(['学校', 'がっこう', 'ﾈｺ', 'ねこ', '食べました', 'たべませんでした', '読んで', '學校', '未収録xx'].map(text => ({ text, language: 'ja' })));
  assert.deepEqual(batch.map(result => result.status), ['found', 'found', 'found', 'found', 'found', 'found', 'found', 'found', 'not_found']);
  assert.equal(batch[4].sources[0].matches[0].matchKind, 'inflection');
  assert.equal(batch[4].sources[0].matches[0].entry.headword, '食べる');
  assert.equal(batch[6].sources[0].matches.length, 1, 'Verb inflection must not return the homographic noun.');
  assert.equal(batch[7].sources[0].matches[0].matchKind, 'normalized');
  const book = await service.lookup({ text: '本', language: 'ja' });
  assert.deepEqual(book.sources[0].matches.map(match => match.entry.headword), ['本'], 'Counters stored in another noun are not that noun’s alternative spelling.');
  const entry = batch[0].sources[0].matches[0].entry;
  assert.equal((await service.getEntry({ dictionaryId: adapter.metadata.id, entryId: entry.entryId })).entry?.headword, '学校');
  const exact = createDictionaryService(); exact.registerDictionary(adapter);
  assert.equal((await exact.lookup({ text: '食べました', language: 'ja' })).status, 'not_found');
  assert.equal((await exact.lookup({ text: '学校', language: 'ja' })).status, 'found');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.lookup({ text: '学校', language: 'ja' }, abort.signal));
  await assert.rejects(importJapaneseDictionary({ sourceFile, outputDir: pack }), /already exists/);
  adapter.close();
  await fs.appendFile(path.join(pack, 'dictionary.sqlite'), 'corruption');
  const broken = new WiktionaryJapaneseAdapter({ dataDir: pack }); adapters.push(broken);
  assert.equal(broken.getStatus().available, false);
  const failed = createDictionaryService(); failed.registerLanguage(japaneseLanguageAdapter); failed.registerDictionary(broken);
  assert.equal((await failed.lookup({ text: '学校', language: 'ja' })).status, 'unavailable');
});

test('runtime supplies Japanese normalization to imported sources without requiring a built-in pack', async () => {
  const source = createInMemoryDictionary({ id: 'ja-import-fixture', language: 'ja', entries: [{ id: 'cat', headword: 'ネコ', definitions: [{ language: 'zh', text: '猫（测试义项）' }] }] });
  const runtime = createDictionaryRuntime({ additionalDictionaries: [source] });
  const result = await runtime.service.lookup({ text: 'ﾈｺ', language: 'ja', dictionaryIds: [source.metadata.id] });
  assert.equal(result.status, 'found');
  assert.equal(result.languageCapabilities.segmentation, 'supported');
  assert.equal(runtime.japaneseChinese, undefined);
  assert.deepEqual(await runtime.resolveLearningTerms(['dogs']), [{ language: 'en', kind: 'word', stableId: 'dog' }]);
  assert.ok(runtime.service.listSources().sources.find(source => source.id === JAPANESE_CHINESE_WIKTIONARY_ID) === undefined);
});
