import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WordNetAdapter, parseWordNetGloss } from '../packages/dictionary/server/wordnet';
import { createDictionaryService } from '../packages/dictionary/core';
import { englishLanguageAdapter } from '../packages/dictionary/languages/english';
import { createInMemoryDictionary } from '../packages/dictionary/examples/inMemory';
import { isDictionaryExampleVisible } from '../packages/dictionary/compat/englishPresentation';
import { toEnglishDictionaryEntry } from '../server/dictionary/compatibility';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { toDictionaryWordCard } from '../src/lib/dictionaryClient';
import { buildDictionaryExplanation } from '../server/dictionary/service';
import { DictionarySenseGroups } from '../src/components/DictionarySenseGroups';
import { unpackWordNet } from '../scripts/dictionary/import-wordnet.mjs';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(t: { after: (callback: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readage-wordnet-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-wordnet-test-'));
    fs.rmSync(directory, { recursive: true });
  });
  const first = '00000000 00 n 02 bank 0 depository_financial_institution 0 000 | a financial institution; "I went to the bank"; "She works at a bank"\n';
  const offset = Buffer.byteLength(first);
  const second = `${String(offset).padStart(8, '0')} 00 n 01 bank 0 000 | sloping land beside water; "They sat on the river bank"\n`;
  const phraseOffset = offset + Buffer.byteLength(second);
  const phrase = `${String(phraseOffset).padStart(8, '0')} 00 n 01 ice_cream 0 000 | a frozen dessert\n`;
  const files: Record<string, Buffer> = { 'LICENSE.txt': Buffer.from('Synthetic test data only.') };
  for (const pos of ['noun', 'verb', 'adj', 'adv']) {
    files[`index.${pos}`] = Buffer.alloc(0); files[`data.${pos}`] = Buffer.alloc(0);
  }
  // Rank differs from byte order: preserve the index's sense order, not sorted offsets.
  files['data.noun'] = Buffer.from(first + second + phrase);
  files['index.noun'] = Buffer.from(`  1 fixture header\nbank n 2 1 @ 2 0 ${String(offset).padStart(8, '0')} 00000000\nice_cream n 1 0 1 0 ${String(phraseOffset).padStart(8, '0')}\n`);
  files['data.adj'] = Buffer.from('00000000 00 s 0a bank 0 b 0 c 0 d 0 e 0 f 0 g 0 h 0 i 0 j 0 000 | a fixture satellite adjective\n');
  files['index.adj'] = Buffer.from('bank a 1 0 1 0 00000000\n');
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes);
  const manifest = { format: 'wordnet-import.v1', release: '3.1', headwordCount: 2,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])) };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, manifest };
}

test('WordNet preserves ranked senses, collocations, satellite POS, hex counts and published examples', async t => {
  const { directory } = fixture(t);
  const adapter = new WordNetAdapter({ dataDir: directory });
  assert.deepEqual(adapter.getStatus(), { available: true });
  assert.equal(adapter.count, 2);
  const entry = await adapter.getEntry('bank');
  assert.equal(entry!.content.kind, 'structured');
  if (entry!.content.kind !== 'structured') throw new Error('Expected structured content.');
  assert.deepEqual(entry!.content.senses.map(sense => sense.partOfSpeech), ['n.', 'n.', 'adj.']);
  assert.equal(entry!.content.senses[0].definitions[0].text, 'sloping land beside water');
  assert.equal(entry!.content.senses[1].examples[0].text.language, 'en');
  assert.equal(entry!.content.senses[1].examples[0].text.text, 'I went to the bank');
  assert.equal(entry!.extensions, undefined, 'WordNet implements only the public neutral contract');
  assert.equal((await adapter.getEntry('ice cream'))?.headword, 'ice cream');
  entry!.headword = 'mutated';
  assert.equal((await adapter.getEntry('bank'))!.headword, 'bank', 'source cache cannot be mutated by a consumer');
});

test('WordNet exact fallback never applies English normalization or guessed stemming', async t => {
  const { directory } = fixture(t);
  const service = createDictionaryService();
  service.registerDictionary(new WordNetAdapter({ dataDir: directory }));
  assert.equal((await service.lookup({ text: 'Bank', language: 'en' })).status, 'not_found');
  assert.equal((await service.lookup({ text: 'banks', language: 'en' })).status, 'not_found');
  service.registerLanguage(englishLanguageAdapter);
  assert.equal((await service.lookup({ text: 'Bank', language: 'en' })).status, 'found');
  assert.equal((await service.lookup({ text: 'banks', language: 'en' })).status, 'not_found');
});

test('WordNet missing or damaged data is unavailable, while the independent native source still works', async t => {
  const { directory, manifest } = fixture(t);
  const before = new WordNetAdapter({ dataDir: directory }).metadata.contentVersion;
  fs.writeFileSync(path.join(directory, 'data.noun'), 'damaged');
  const runtime = createDictionaryRuntime({ wordnetDir: directory, enabledSources: ['wordnet', 'native-reviewed'],
    sourceOrder: ['wordnet', 'native-reviewed'], defaultSource: 'wordnet', dataDir: path.join(directory, 'missing-ecdict') });
  const result = await runtime.service.lookup({ text: 'bank', language: 'en' });
  assert.equal(result.status, 'found');
  assert.equal(result.sources[0].status, 'unavailable');
  assert.equal(toEnglishDictionaryEntry(result)!.dictionaryRef.dictionaryId, 'native-reviewed');
  const service = createDictionaryService(); service.registerDictionary(new WordNetAdapter({ dataDir: directory }));
  assert.equal((await service.lookup({ text: 'not-in-dictionary', language: 'en' })).status, 'unavailable');
  manifest.files['data.noun'].sha256 = sha256(Buffer.from('damaged'));
  manifest.files['data.noun'].bytes = 7;
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  assert.notEqual(new WordNetAdapter({ dataDir: directory }).metadata.contentVersion, before);
  const missing = new WordNetAdapter({ dataDir: path.join(directory, 'missing') });
  assert.equal(missing.getStatus().available, false);
  await assert.rejects(missing.getEntry('bank'));
});

test('generic English compatibility honors a third-party source without merging other dictionaries senses', async t => {
  const { directory } = fixture(t);
  const runtime = createDictionaryRuntime({ wordnetDir: directory, sourceOrder: ['wordnet', 'native-reviewed', 'ecdict'], defaultSource: 'wordnet' });
  const result = await runtime.service.lookup({ text: 'bank', language: 'en' });
  const entry = toEnglishDictionaryEntry(result)!;
  assert.equal(entry.dictionaryRef.dictionaryId, 'wordnet');
  assert.equal(entry.dictionaryRef.dictionaryName, 'WordNet 3.1');
  assert.equal(entry.dictionaryRef.fieldSources.phonetic.dictionaryId, 'ecdict');
  assert.equal(entry.learningTermRef?.stableId, 'bank');
  assert.ok(entry.phonetic);
  assert.equal(entry.partOfSpeechGroups.flatMap(group => group.senses).length, 3);
  assert.deepEqual(entry.basicMeaningsZh, [], 'ECDICT translations must not be paired with WordNet senses');
  assert.equal(entry.edit.reviewStatus, 'unreviewed', 'published third-party data is not locally reviewed');
  const card = toDictionaryWordCard(entry);
  assert.equal(card.exampleSentences.length, 3);
  assert.deepEqual(buildDictionaryExplanation('bank', entry).exampleSentences, card.exampleSentences);
  const html = renderToStaticMarkup(React.createElement(DictionarySenseGroups, { record: entry }));
  assert.ok(html.includes('I went to the bank'));
  assert.ok(!html.includes('中文释义待审核'));
  assert.equal((await runtime.service.lookup({ text: 'bank', language: 'en', dictionaryIds: ['native-reviewed'] })).sources.length, 1);
});

test('the generic bridge also accepts an unrelated plugin and keeps unpublished authored examples hidden', async () => {
  const external = createInMemoryDictionary({ id: 'public-demo', language: 'en', contentVersion: 'v1',
    entries: [{ id: 'example', headword: 'example', definitions: [{ language: 'en', text: 'a representative instance' }] }] });
  const service = createDictionaryService(); service.registerDictionary(external);
  const entry = toEnglishDictionaryEntry(await service.lookup({ text: 'example', language: 'en' }))!;
  assert.equal(entry.dictionaryRef.dictionaryId, 'public-demo');
  assert.equal(entry.definitionEn, 'a representative instance');
  assert.equal(isDictionaryExampleVisible({ id: 'unreviewed', en: 'draft', source: { kind: 'manual', status: 'confirmed' }, reviewStatus: 'unreviewed' }), false);
});

test('WordNet-only batch queries preserve positions and support cancellation', async t => {
  const { directory } = fixture(t);
  const service = createDictionaryService(); service.registerDictionary(new WordNetAdapter({ dataDir: directory }));
  const result = await service.lookupMany(['ice cream', 'absent', 'bank'].map(text => ({ text, language: 'en' })));
  assert.deepEqual(result.map(item => item.status), ['found', 'not_found', 'found']);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.lookup({ text: 'bank', language: 'en' }, controller.signal), { name: 'AbortError' });
});

test('WordNet gloss parser preserves quoted terms in definitions and separates full example sentences', () => {
  assert.deepEqual(parseWordNetGloss('a word called "bank"; a reserve; "He said, \'hello\'; then left"; "Second example"'),
    { definition: 'a word called "bank"; a reserve', examples: ["He said, 'hello'; then left", 'Second example'] });
  assert.throws(() => unpackWordNet(Buffer.from('untrusted archive')), /checksum/);
});

const installed = path.resolve('data/dictionary/imported/wordnet-3.1');
test('official WordNet 3.1 integration keeps running display independent from the run learning identity',
  { skip: !fs.existsSync(path.join(installed, 'manifest.json')) }, async () => {
    const runtime = createDictionaryRuntime({ wordnetDir: installed, sourceOrder: ['wordnet', 'native-reviewed', 'ecdict'], defaultSource: 'wordnet' });
    assert.equal(runtime.wordnet!.count, 147478);
    const entry = toEnglishDictionaryEntry(await runtime.service.lookup({ text: 'running', language: 'en' }))!;
    assert.equal(entry.lemma, 'running');
    assert.equal(entry.learningTermRef?.stableId, 'run');
    assert.equal(entry.phonetic, '', 'the IPA of run is not the IPA of running');
    assert.equal(entry.dictionaryRef.fieldSources.phonetic.dictionaryId, 'wordnet');
    const only = await runtime.service.lookup({ text: 'serendipity', language: 'en', dictionaryIds: ['wordnet'] });
    assert.equal(only.status, 'found');
    const detail = await runtime.service.getEntry({ dictionaryId: 'wordnet', entryId: 'ice cream' });
    assert.equal(detail.status, 'found');
    assert.equal(detail.entry!.extensions, undefined);
    assert.deepEqual((await createDictionaryRuntime().resolveLearningTerms(['running', 'books', 'studies'])),
      await runtime.resolveLearningTerms(['running', 'books', 'studies']));
  });
