import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { toEnglishDictionaryEntry } from '../server/dictionary/compatibility';
import { buildDictionaryExplanation } from '../server/dictionary/service';
import { toDictionaryWordCard, toDictionarySourceWordCard } from '../src/lib/dictionaryClient';
import { createWordCardRequest, fetchWordCard } from '../src/lib/wordCard';
import { dictionaryCatalogCache } from '../src/lib/dictionaryCatalog';
import { getCompactWordCard } from '../src/lib/compactWordCard';
import { buildVocabularyExportRows } from '../src/lib/vocabularyExport';
import { READAGE_AUTHORED_EXTENSION, type ReadAgePackIndex, type ReadAgeWord } from '../packages/dictionary/readage';
import { ReadAgeAuthoredAdapter } from '../packages/dictionary/server/readageAuthored';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DictionarySourceSections } from '../src/components/DictionarySourceSections';

const index = JSON.parse(fs.readFileSync('data/dictionary/readage/index.json', 'utf8')) as ReadAgePackIndex;
const manifest = JSON.parse(fs.readFileSync('data/dictionary/readage/manifest.json', 'utf8'));

test('the complete 17,974-entry ReadAge corpus reaches both APIs, cards and export without losing authored fields', async () => {
  const app = createDictionaryRuntime({ enabledSources: ['native-reviewed'] });
  assert.equal(index.entries.length, 17974);
  assert.equal(manifest.senseCount, 30538);
  assert.equal(app.native.count, index.entries.length);
  assert.equal(app.service.listSources().defaultSource, 'native-reviewed');
  const file = fs.openSync('data/dictionary/readage/entries.pack', 'r');
  let senses = 0;
  try {
  for (let start = 0; start < index.entries.length; start += 50) {
  const batch = index.entries.slice(start, start + 50);
  const results = await app.service.lookupMany(batch.map(item => ({ text: item.headword, language: 'en' })));
  for (const [position, result] of results.entries()) {
    const item = batch[position];
    const bytes = Buffer.alloc(item.length);
    fs.readSync(file, bytes, 0, bytes.length, item.offset);
    const original = JSON.parse(gunzipSync(bytes).toString('utf8')) as ReadAgeWord;
    const entry = toEnglishDictionaryEntry(result)!;
    assert.equal(result.status, 'found', original.lemma);
    assert.equal(entry.dictionaryRef.dictionaryId, 'native-reviewed', original.lemma);
    assert.equal(entry.dictionarySources[0].dictionaryRef.dictionaryName, 'ReadAge 自编词典');
    const authoredSenses = original.senses;
    senses += authoredSenses.length;
    const source = entry.dictionarySources[0];
    assert.deepEqual(source.readageContent, original, original.lemma);
    const byId = source.record.partOfSpeechGroups.flatMap(group => group.senses);
    assert.equal(byId.length, authoredSenses.length);
    for (const sense of authoredSenses) {
      const converted = byId.find(item => item.id === sense.id)!;
      assert.equal(converted.definitionEn, sense.definitionEn);
      assert.equal(converted.definitionZh, sense.definitionZhTranslation);
      assert.deepEqual(converted.examples.map(example => [example.en, example.zh]), sense.examples.map(example => [example.english, example.chinese]));
    }
    const card = toDictionaryWordCard(entry);
    assert.equal(card.dictionaryRef?.dictionaryId, 'native-reviewed');
    assert.deepEqual(card.dictionarySources, entry.dictionarySources);
    assert.deepEqual(card.exampleSentences, byId.flatMap(sense => sense.examples.map(example => example.en)));
    assert.deepEqual(buildDictionaryExplanation(original.lemma, entry).dictionarySources, card.dictionarySources);
    const compact = getCompactWordCard(toDictionarySourceWordCard(source), original.lemma);
    assert.equal(compact.definitionEn, byId[0].definitionEn);
    assert.equal(compact.meaningZh, byId[0].definitionZh);
    const rows = buildVocabularyExportRows([{ wordId: original.lemma, level: 1, memoryScore: 30 }], [entry]);
    assert.equal(rows[0].translation, entry.basicMeaningsZh.slice(0, 2).join('；'));
    const details = (await app.service.getEntry({ dictionaryId: 'native-reviewed', entryId: original.id })).entry!;
    assert.equal(details.headword, original.lemma);
    assert.deepEqual(details.extensions?.[READAGE_AUTHORED_EXTENSION], original);
  }
  }
  } finally { fs.closeSync(file); }
  assert.equal(senses, manifest.senseCount);
});

test('ReadAge deep modules and original bilingual definitions are visible in the full card', async () => {
  const app = createDictionaryRuntime({ enabledSources: ['native-reviewed'] });
  const entry = toEnglishDictionaryEntry(await app.service.lookup({ text: 'adapt', language: 'en' }))!;
  const html = renderToStaticMarkup(React.createElement(DictionarySourceSections, { sources: entry.dictionarySources }));
  for (const label of ['中文详解', '句子结构', '词源与构词', '形近与易混词', '近义词与反义词辨析', '常见错误', '语境与长难句', '即时检测', '参考来源']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('adapt.s1') === false, 'internal source IDs stay out of the reader interface');
  assert.ok(html.includes('To change your behaviour or way of thinking'));
  assert.ok(html.includes('改变自己的行为方式或思维方式'));
  assert.ok(!html.includes('&lt;b&gt;'), 'authored formatting goes through the safe content renderer');
  const failed = new ReadAgeAuthoredAdapter({ dataDir: 'data/no-such-readage-pack' });
  assert.equal(failed.count, 0);
  assert.equal(failed.metadata.entryCount, undefined);
  await assert.rejects(failed.getEntry('adapt'));
});

test('shared reading, search and review cache follows source settings without rewriting learning identity', async () => {
  const app = createDictionaryRuntime();
  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  let lookups = 0;
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, '/api/dictionary/lookup');
    lookups++;
    const { words } = JSON.parse(String(init?.body));
    const results = await app.service.lookupMany(words.map((text: string) => ({ text, language: 'en' })));
    return new Response(JSON.stringify({ ok: true, results: results.map(toEnglishDictionaryEntry) }));
  }) as typeof fetch;
  try {
    await dictionaryCatalogCache.applyCatalog(app.service.listSources(), false);
    const request = createWordCardRequest('running')!;
    const first = await fetchWordCard(request);
    assert.equal(first.dictionaryRef?.dictionaryId, 'native-reviewed');
    assert.equal(first.learningTermRef?.stableId, 'run');
    assert.equal((await fetchWordCard(request)).dictionaryRef?.dictionaryId, 'native-reviewed');
    assert.equal(lookups, 1);
    const settings = app.settings.snapshot().settings;
    await app.settings.update({ ...settings, expectedRevision: settings.revision, sourceOrder: ['ecdict', 'native-reviewed'], defaultSource: 'ecdict' });
    await dictionaryCatalogCache.applyCatalog(app.service.listSources(), false);
    const changed = await fetchWordCard(request);
    assert.equal(changed.dictionaryRef?.dictionaryId, 'ecdict');
    assert.equal(changed.learningTermRef?.stableId, first.learningTermRef?.stableId);
    assert.equal(lookups, 2);
    await fetchWordCard(request, { forceRefresh: true });
    assert.equal(lookups, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
